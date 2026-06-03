// APK + reverse-engineering tools. These shell out to the standard Android RE
// toolchain (apktool, aapt2, zipalign, apksigner, jadx, dex2jar, smali) which
// install.sh provisions. They are model-agnostic: any selected AI model can
// drive the full build / decompile / recompile / modify / analyse workflow for
// every APK framework, because the heavy lifting runs locally here.

import fs from "node:fs";
import path from "node:path";
import {
  resolvePath,
  runCommand,
  which,
  parseBuildProgress,
  spanPercent,
  summarizeAbiCompatibility,
  COMMON_ABIS,
} from "./util.js";

function resolve(p, ws) {
  return resolvePath(p, ws);
}

async function run(argv, { cwd, timeout = 900000, onData } = {}) {
  return runCommand({ argv, cwd, timeout, maxChars: 15000, onData });
}

// Report build progress to the chat status card if the bot wired up a callback.
function report(ctx, payload) {
  try {
    ctx?.onProgress?.(payload);
  } catch {
    /* progress reporting must never break a build */
  }
}

// Build an onData handler that maps a build tool's live output into a % within
// the [floor, ceil] window of the current phase.
function progressParser(ctx, tool, floor, ceil, label) {
  return (chunk) => {
    const prog = parseBuildProgress(chunk, tool);
    if (prog) report(ctx, { percent: spanPercent(prog.fraction, floor, ceil), label, ceil });
  };
}

// List the native ABIs (lib/<abi>/) present in an APK/zip.
async function apkAbis(apkPath) {
  const names = await listZip(apkPath);
  if (!names) return null;
  const abis = new Set();
  for (const n of names) {
    const m = n.match(/^lib\/([^/]+)\//);
    if (m) abis.add(m[1]);
  }
  return [...abis].sort();
}

// Verify an APK's signature with apksigner. Returns a structured result the
// agent can use to self-check before delivering. Never throws.
async function verifyApkSignature(apkPath) {
  if (!which("apksigner")) return { ok: null, reason: "apksigner not installed" };
  const r = await run(["apksigner", "verify", "--verbose", apkPath], { timeout: 120000 });
  const text = `${r.stdout || ""}\n${r.stderr || ""}`;
  const verified = r.exit_code === 0 && /Verified using v\d|Verifies/i.test(text);
  const schemes = [];
  for (const v of ["v1", "v2", "v3", "v4"]) {
    const m = text.match(new RegExp(`scheme ${v}\\):\\s*(true|false)`, "i"));
    if (m) schemes.push(`${v}=${m[1].toLowerCase()}`);
  }
  return {
    ok: verified,
    schemes,
    exit_code: r.exit_code,
    output: text.trim().slice(0, 1500),
  };
}

// Android runtime ("dangerous") permission groups worth flagging in an audit.
const DANGEROUS_PERMS = new Set([
  "READ_CONTACTS", "WRITE_CONTACTS", "GET_ACCOUNTS",
  "READ_CALENDAR", "WRITE_CALENDAR",
  "CAMERA", "RECORD_AUDIO",
  "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "ACCESS_BACKGROUND_LOCATION",
  "READ_PHONE_STATE", "READ_PHONE_NUMBERS", "CALL_PHONE", "ANSWER_PHONE_CALLS",
  "READ_CALL_LOG", "WRITE_CALL_LOG", "PROCESS_OUTGOING_CALLS",
  "BODY_SENSORS",
  "SEND_SMS", "RECEIVE_SMS", "READ_SMS", "RECEIVE_WAP_PUSH", "RECEIVE_MMS",
  "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "MANAGE_EXTERNAL_STORAGE",
  "ACCESS_MEDIA_LOCATION", "ACTIVITY_RECOGNITION",
]);

// Known third-party SDKs / trackers, detected by class-path prefixes inside the
// dex (we match against the zip entry list + smali-style package roots).
const TRACKER_SIGNATURES = [
  { name: "Google Firebase", re: /(^|\/)com\/google\/firebase\// },
  { name: "Google Play Services", re: /(^|\/)com\/google\/android\/gms\// },
  { name: "Google AdMob/Ads", re: /(^|\/)com\/google\/android\/gms\/ads\// },
  { name: "Facebook SDK", re: /(^|\/)com\/facebook\// },
  { name: "AppsFlyer", re: /(^|\/)com\/appsflyer\// },
  { name: "Adjust", re: /(^|\/)com\/adjust\/sdk\// },
  { name: "Flurry", re: /(^|\/)com\/flurry\// },
  { name: "Crashlytics", re: /(^|\/)com\/(crashlytics|google\/firebase\/crashlytics)\// },
  { name: "OneSignal", re: /(^|\/)com\/onesignal\// },
  { name: "Unity Ads", re: /(^|\/)com\/unity3d\/ads\// },
  { name: "ironSource", re: /(^|\/)com\/ironsource\// },
  { name: "AppLovin", re: /(^|\/)com\/applovin\// },
  { name: "Branch", re: /(^|\/)io\/branch\// },
  { name: "Sentry", re: /(^|\/)io\/sentry\// },
  { name: "Amplitude", re: /(^|\/)com\/amplitude\// },
  { name: "Mixpanel", re: /(^|\/)com\/mixpanel\// },
];

// Parse `aapt dump badging` into a structured object (package/version/sdk,
// permissions, features, debuggable flag). Returns null if aapt is unavailable.
async function aaptBadging(apkPath) {
  const aapt = which("aapt2") || which("aapt");
  if (!aapt) return null;
  const info = await run([aapt, "dump", "badging", apkPath], { timeout: 120000 });
  const out = info.stdout || "";
  if (!out) return null;
  const res = { permissions: [], features: [] };
  let m = out.match(/package: name='([^']+)' versionCode='([^']*)' versionName='([^']*)'/);
  if (m) {
    res.package = m[1];
    res.version_code = m[2];
    res.version_name = m[3];
  }
  m = out.match(/sdkVersion:'([^']+)'/);
  if (m) res.min_sdk = m[1];
  m = out.match(/targetSdkVersion:'([^']+)'/);
  if (m) res.target_sdk = m[1];
  const perms = new Set();
  for (const pm of out.matchAll(/uses-permission: name='([^']+)'/g)) perms.add(pm[1]);
  res.permissions = [...perms].sort();
  const feats = new Set();
  for (const fm of out.matchAll(/uses-feature(?:-not-required)?: name='([^']+)'/g)) feats.add(fm[1]);
  res.features = [...feats].sort();
  res.debuggable = /application-debuggable/.test(out);
  return res;
}

// Split permissions into dangerous vs normal by their short name.
function classifyPermissions(perms) {
  const dangerous = [];
  for (const p of perms || []) {
    const short = p.split(".").pop();
    if (DANGEROUS_PERMS.has(short)) dangerous.push(p);
  }
  return dangerous.sort();
}

// Detect known trackers/SDKs from a zip entry list (test each entry name so the
// (^|/) anchor works regardless of position).
function detectTrackers(names) {
  const list = names || [];
  const found = [];
  for (const t of TRACKER_SIGNATURES) {
    if (list.some((n) => t.re.test(n))) found.push(t.name);
  }
  return [...new Set(found)];
}

// `unzip -v` → map of entry name -> crc, for content diffing.
async function zipCrcMap(apkPath) {
  const r = await runCommand({ argv: ["unzip", "-v", apkPath], timeout: 120000, maxChars: 800000 });
  if (r.error || r.exit_code !== 0) return null;
  const map = new Map();
  for (const line of (r.stdout || "").split("\n")) {
    // columns: Length Method Size Cmpr Date Time CRC-32 Name
    const m = line.match(/^\s*\d+\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+([0-9a-fA-F]{8})\s+(.+)$/);
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

function stem(p) {
  const b = path.basename(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

// List entry names inside an APK/zip using `unzip -Z1` (unzip is a core dep).
async function listZip(apkPath) {
  const r = await runCommand({ argv: ["unzip", "-Z1", apkPath], timeout: 60000, maxChars: 400000 });
  if (r.error || r.exit_code !== 0) return null;
  return (r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
}

function keystoreOf(ctx, args) {
  return {
    keystore: args.keystore || ctx.keystore,
    storepass: args.storepass || ctx.keystorePass || "android",
    keypass: args.keypass || ctx.keystorePass || "android",
    alias: args.alias || ctx.keystoreAlias || "androiddebugkey",
  };
}

export function register(reg) {
  // ---------------------------------------------------------------- detect
  reg.register({
    name: "detect_apk_type",
    description:
      "Inspect an APK and report frameworks (Flutter/Unity/Xamarin/React Native/Hermes/Kotlin/native-java), ABIs, files of interest, and package/version/SDK info (via aapt).",
    parameters: {
      type: "object",
      properties: { apk: { type: "string" } },
      required: ["apk"],
    },
    handler: async (args, ctx) => {
      const p = resolve(args.apk, ctx.workspace);
      if (!fs.existsSync(p)) return { error: `apk not found: ${p}` };
      const names = await listZip(p);
      if (!names) return { error: "could not read APK (not a valid zip, or unzip missing)" };
      const set = new Set(names);
      const findings = {
        apk: p,
        size: fs.statSync(p).size,
        frameworks: [],
        abis: [],
        files_of_interest: [],
        package: null,
        version_name: null,
        version_code: null,
        min_sdk: null,
        target_sdk: null,
      };
      const abis = new Set();
      for (const n of names) {
        const m = n.match(/^lib\/([^/]+)\//);
        if (m) abis.add(m[1]);
      }
      findings.abis = [...abis].sort();
      const hasSo = (needle) =>
        names.some((n) => n.startsWith("lib/") && n.endsWith(`/${needle}`));
      const fw = findings.frameworks;
      if (hasSo("libflutter.so") || hasSo("libapp.so")) fw.push("flutter");
      if (hasSo("libil2cpp.so") || set.has("assets/bin/Data/Managed/Metadata/global-metadata.dat"))
        fw.push("unity-il2cpp");
      if (hasSo("libmono.so") || names.some((n) => n.startsWith("assemblies/")))
        fw.push("xamarin/.net");
      if (set.has("assets/index.android.bundle") ||
        names.some((n) => n.startsWith("assets/") && n.endsWith(".bundle")))
        fw.push("react-native");
      if (hasSo("libhermes.so")) fw.push("hermes");
      if (names.some((n) => n.endsWith(".dex"))) fw.push("dalvik/dex");
      if (names.some((n) => n.startsWith("kotlin/") || n.endsWith(".kotlin_module")))
        fw.push("kotlin");
      if (hasSo("libreactnativejni.so") || hasSo("libreactnative.so")) fw.push("react-native");
      if (!fw.length) fw.push("native-java");
      for (const needle of [
        "AndroidManifest.xml",
        "classes.dex",
        "assets/flutter_assets/kernel_blob.bin",
        "assets/index.android.bundle",
        "assets/bin/Data/Managed/Metadata/global-metadata.dat",
        "META-INF/MANIFEST.MF",
      ]) {
        if (set.has(needle)) findings.files_of_interest.push(needle);
      }
      const aapt = which("aapt2") || which("aapt");
      if (aapt) {
        const info = await run([aapt, "dump", "badging", p], { timeout: 60000 });
        const out = info.stdout || "";
        let m = out.match(/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/);
        if (m) {
          findings.package = m[1];
          findings.version_code = m[2];
          findings.version_name = m[3];
        }
        m = out.match(/sdkVersion:'([^']+)'/);
        if (m) findings.min_sdk = m[1];
        m = out.match(/targetSdkVersion:'([^']+)'/);
        if (m) findings.target_sdk = m[1];
      }
      // Device compatibility based on the native ABIs present.
      findings.compatibility = summarizeAbiCompatibility(findings.abis);
      return findings;
    },
  });

  // ------------------------------------------------------------- decompile
  reg.register({
    name: "apk_decompile",
    description: "Decompile an APK with apktool (smali + resources). Returns the output dir.",
    parameters: {
      type: "object",
      properties: {
        apk: { type: "string" },
        out_dir: { type: "string" },
        force: { type: "boolean" },
        no_src: { type: "boolean", description: "Skip disassembling dex to smali." },
        no_res: { type: "boolean", description: "Skip decoding resources." },
      },
      required: ["apk"],
    },
    handler: async (args, ctx) => {
      const p = resolve(args.apk, ctx.workspace);
      if (!fs.existsSync(p)) return { error: `apk not found: ${p}` };
      const outDir = resolve(args.out_dir || `${stem(p)}.decompiled`, ctx.workspace);
      if (fs.existsSync(outDir) && !args.force)
        return { error: `output exists: ${outDir} — pass force=true to overwrite` };
      if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
      if (!which("apktool")) return { error: "apktool not installed — run install.sh" };
      const argv = ["apktool", "d", p, "-o", outDir];
      if (args.no_src) argv.push("--no-src");
      if (args.no_res) argv.push("--no-res");
      const r = await run(argv);
      r.out_dir = outDir;
      return r;
    },
  });

  // ------------------------------------------------------------- recompile
  reg.register({
    name: "apk_recompile",
    description: "Rebuild an APK from an apktool project dir. Returns the unsigned APK path.",
    parameters: {
      type: "object",
      properties: {
        src_dir: { type: "string" },
        out_apk: { type: "string" },
        use_aapt2: { type: "boolean" },
      },
      required: ["src_dir"],
    },
    handler: async (args, ctx) => {
      const sp = resolve(args.src_dir, ctx.workspace);
      if (!fs.existsSync(sp)) return { error: `src_dir not found: ${sp}` };
      const outApk = resolve(args.out_apk || `${sp}.unsigned.apk`, ctx.workspace);
      if (!which("apktool")) return { error: "apktool not installed — run install.sh" };
      const argv = ["apktool", "b", sp, "-o", outApk];
      if (args.use_aapt2 !== false) argv.push("--use-aapt2");
      report(ctx, { percent: 5, label: "Recompile APK", ceil: 95 });
      const r = await run(argv, { onData: progressParser(ctx, "apktool", 5, 95, "Recompile APK") });
      report(ctx, { percent: 100, label: "Recompile siap" });
      r.out_apk = outApk;
      return r;
    },
  });

  // -------------------------------------------------------------- zipalign
  reg.register({
    name: "apk_zipalign",
    description: "Zipalign an APK (4-byte alignment). Returns the aligned APK path.",
    parameters: {
      type: "object",
      properties: { apk: { type: "string" }, out: { type: "string" } },
      required: ["apk"],
    },
    handler: async (args, ctx) => {
      const sp = resolve(args.apk, ctx.workspace);
      if (!fs.existsSync(sp)) return { error: `apk not found: ${sp}` };
      const out = resolve(args.out || sp.replace(/\.apk$/i, "") + ".aligned.apk", ctx.workspace);
      if (!which("zipalign")) return { error: "zipalign not installed — run install.sh" };
      const r = await run(["zipalign", "-p", "-f", "4", sp, out], { timeout: 300000 });
      r.out = out;
      return r;
    },
  });

  // ------------------------------------------------------------------ sign
  reg.register({
    name: "apk_sign",
    description: "Sign an APK with the local debug keystore (apksigner). Returns the signed APK path.",
    parameters: {
      type: "object",
      properties: {
        apk: { type: "string" },
        out: { type: "string" },
        keystore: { type: "string" },
        storepass: { type: "string" },
        keypass: { type: "string" },
        alias: { type: "string" },
      },
      required: ["apk"],
    },
    handler: async (args, ctx) => {
      const sp = resolve(args.apk, ctx.workspace);
      if (!fs.existsSync(sp)) return { error: `apk not found: ${sp}` };
      const out = resolve(args.out || sp.replace(/\.apk$/i, "") + ".signed.apk", ctx.workspace);
      const ks = keystoreOf(ctx, args);
      if (!ks.keystore || !fs.existsSync(ks.keystore))
        return { error: `keystore not found at ${ks.keystore} — run install.sh or pass keystore=<path>` };
      if (!which("apksigner")) return { error: "apksigner not installed — run install.sh" };
      fs.copyFileSync(sp, out);
      const argv = [
        "apksigner", "sign",
        "--ks", ks.keystore,
        "--ks-key-alias", ks.alias,
        "--ks-pass", `pass:${ks.storepass}`,
        "--key-pass", `pass:${ks.keypass}`,
        out,
      ];
      const r = await run(argv, { timeout: 300000 });
      r.out = out;
      return r;
    },
  });

  reg.register({
    name: "apk_verify_signature",
    description: "Verify an APK's signature and print signer certificates (apksigner verify).",
    parameters: {
      type: "object",
      properties: { apk: { type: "string" } },
      required: ["apk"],
    },
    handler: async (args, ctx) => {
      const p = resolve(args.apk, ctx.workspace);
      if (!which("apksigner")) return { error: "apksigner not installed — run install.sh" };
      return run(["apksigner", "verify", "--print-certs", "-v", p], { timeout: 120000 });
    },
  });

  reg.register({
    name: "apk_aapt_dump",
    description: "Run aapt/aapt2 dump (badging, permissions, resources, etc.) on an APK.",
    parameters: {
      type: "object",
      properties: {
        apk: { type: "string" },
        what: { type: "string", description: "badging | permissions | resources | configurations" },
      },
      required: ["apk"],
    },
    handler: async (args, ctx) => {
      const p = resolve(args.apk, ctx.workspace);
      const aapt = which("aapt2") || which("aapt");
      if (!aapt) return { error: "aapt/aapt2 not installed — run install.sh" };
      return run([aapt, "dump", args.what || "badging", p], { timeout: 120000 });
    },
  });

  // ------------------------------------------------------- one-shot build
  reg.register({
    name: "apk_build_full",
    description:
      "Convenience: recompile an apktool project, then zipalign, then sign with the debug keystore — in one step. Returns the final signed+aligned APK path (good to deliver).",
    parameters: {
      type: "object",
      properties: { src_dir: { type: "string" }, out_apk: { type: "string" } },
      required: ["src_dir"],
    },
    handler: async (args, ctx) => {
      const sp = resolve(args.src_dir, ctx.workspace);
      if (!fs.existsSync(sp)) return { error: `src_dir not found: ${sp}` };
      if (!which("apktool")) return { error: "apktool not installed — run install.sh" };
      // Phase 1: recompile (0–60%).
      report(ctx, { percent: 3, label: "Recompile APK", ceil: 60 });
      const unsigned = `${sp}.unsigned.apk`;
      const bargv = ["apktool", "b", sp, "-o", unsigned, "--use-aapt2"];
      const build = await run(bargv, { onData: progressParser(ctx, "apktool", 3, 58, "Recompile APK") });
      if (build.exit_code !== 0)
        return { stage: "recompile", ...build, error: build.error || "apktool build failed" };
      // Phase 2: zipalign (60–75%).
      report(ctx, { percent: 60, label: "Zipalign APK", ceil: 75 });
      let aligned = unsigned;
      if (which("zipalign")) {
        aligned = `${sp}.aligned.apk`;
        const za = await run(["zipalign", "-p", "-f", "4", unsigned, aligned], { timeout: 300000 });
        if (za.exit_code !== 0) return { stage: "zipalign", ...za };
      }
      report(ctx, { percent: 75, label: "Menandatangani APK", ceil: 95 });
      // Phase 3: sign (75–100%).
      const out = resolve(args.out_apk || `${stem(sp)}.signed.apk`, ctx.workspace);
      const ks = keystoreOf(ctx, args);
      if (!ks.keystore || !fs.existsSync(ks.keystore))
        return { error: `keystore not found at ${ks.keystore} — run install.sh` };
      if (!which("apksigner")) return { error: "apksigner not installed — run install.sh" };
      fs.copyFileSync(aligned, out);
      const sign = await run(
        [
          "apksigner", "sign",
          "--ks", ks.keystore,
          "--ks-key-alias", ks.alias,
          "--ks-pass", `pass:${ks.storepass}`,
          "--key-pass", `pass:${ks.keypass}`,
          out,
        ],
        { timeout: 300000 },
      );
      if (sign.exit_code !== 0) return { stage: "sign", ...sign };
      report(ctx, { percent: 95, label: "Mengesahkan APK" });
      // Self-verify: confirm the signature is valid and report compatibility so
      // the agent doesn't have to trust the build blindly.
      const verification = await verifyApkSignature(out);
      report(ctx, { percent: 100, label: "APK siap" });
      const abis = await apkAbis(out);
      const compatibility = abis == null ? null : summarizeAbiCompatibility(abis);
      return {
        ok: true,
        out_apk: out,
        verified: verification.ok,
        verification,
        compatibility,
        note:
          verification.ok === false
            ? "WARNING: apksigner could not verify the signature — investigate before delivering."
            : "Final signed + aligned APK ready and signature-verified. Call deliver to send it.",
      };
    },
  });

  // --------------------------------------------------------- verify_apk
  reg.register({
    name: "verify_apk",
    description:
      "Self-check a finished APK before delivering: verifies the signature (apksigner), confirms it is a valid zip, " +
      "and reports its ABIs / device compatibility. Use this to make sure a built or signed APK is actually valid and installable.",
    parameters: {
      type: "object",
      properties: { apk: { type: "string" } },
      required: ["apk"],
    },
    handler: async (args, ctx) => {
      const p = resolve(args.apk, ctx.workspace);
      if (!fs.existsSync(p)) return { error: `apk not found: ${p}` };
      const names = await listZip(p);
      const valid_zip = Array.isArray(names);
      const has_manifest = valid_zip && names.includes("AndroidManifest.xml");
      const signature = await verifyApkSignature(p);
      const abis = await apkAbis(p);
      const compatibility = abis == null ? null : summarizeAbiCompatibility(abis);
      const ok = valid_zip && has_manifest && signature.ok !== false;
      return {
        apk: p,
        ok,
        valid_zip,
        has_manifest,
        signature,
        compatibility,
        note: ok
          ? "APK looks valid and installable."
          : "APK failed a check — see signature/valid_zip/has_manifest above before delivering.",
      };
    },
  });

  // --------------------------------------------------------- apk_audit
  reg.register({
    name: "apk_audit",
    description:
      "Security/privacy audit of an APK: lists permissions (flagging dangerous ones), detects known trackers/ad SDKs, " +
      "reports debuggable/signature status, package/version/SDK info, and device (ABI) compatibility. " +
      "Use this to tell the user what an app can access and whether it looks safe/legit.",
    parameters: {
      type: "object",
      properties: { apk: { type: "string" } },
      required: ["apk"],
    },
    handler: async (args, ctx) => {
      const p = resolve(args.apk, ctx.workspace);
      if (!fs.existsSync(p)) return { error: `apk not found: ${p}` };
      const names = (await listZip(p)) || [];
      const badging = await aaptBadging(p);
      const permissions = badging?.permissions || [];
      const dangerous = classifyPermissions(permissions);
      const trackers = detectTrackers(names);
      const abis = await apkAbis(p);
      const compatibility = abis == null ? null : summarizeAbiCompatibility(abis);
      const signature = await verifyApkSignature(p);

      const warnings = [];
      if (badging?.debuggable) warnings.push("APK debuggable (android:debuggable=true) — tidak sesuai untuk edaran.");
      if (signature.ok === false) warnings.push("Tandatangan tidak sah / tidak ditandatangani.");
      if (dangerous.length >= 6) warnings.push(`Banyak permission sensitif (${dangerous.length}).`);
      if (trackers.length) warnings.push(`Mengandungi tracker/SDK pihak ketiga: ${trackers.join(", ")}.`);

      return {
        apk: p,
        package: badging?.package,
        version_name: badging?.version_name,
        version_code: badging?.version_code,
        min_sdk: badging?.min_sdk,
        target_sdk: badging?.target_sdk,
        debuggable: badging?.debuggable ?? null,
        permissions,
        dangerous_permissions: dangerous,
        permission_count: permissions.length,
        trackers,
        signature: { ok: signature.ok, schemes: signature.schemes },
        compatibility,
        warnings,
        note: badging
          ? warnings.length
            ? "Audit siap — ada perkara untuk diberi perhatian (lihat warnings)."
            : "Audit siap — tiada isu jelas dikesan."
          : "aapt tidak dipasang — permission/version tidak dapat dibaca; jalankan install.sh. (Tracker & ABI masih dilaporkan.)",
      };
    },
  });

  // ---------------------------------------------------------- apk_diff
  reg.register({
    name: "apk_diff",
    description:
      "Compare two APKs and report what changed: package/version, permissions added/removed, ABIs added/removed, " +
      "and files added/removed/modified (by CRC). Useful for auditing a mod vs the original or two app versions.",
    parameters: {
      type: "object",
      properties: { apk_a: { type: "string" }, apk_b: { type: "string" } },
      required: ["apk_a", "apk_b"],
    },
    handler: async (args, ctx) => {
      const a = resolve(args.apk_a, ctx.workspace);
      const b = resolve(args.apk_b, ctx.workspace);
      if (!fs.existsSync(a)) return { error: `apk not found: ${a}` };
      if (!fs.existsSync(b)) return { error: `apk not found: ${b}` };

      const [ba, bb] = [await aaptBadging(a), await aaptBadging(b)];
      const permsA = new Set(ba?.permissions || []);
      const permsB = new Set(bb?.permissions || []);
      const [abisA, abisB] = [(await apkAbis(a)) || [], (await apkAbis(b)) || []];
      const setA = new Set(abisA);
      const setB = new Set(abisB);
      const [crcA, crcB] = [await zipCrcMap(a), await zipCrcMap(b)];

      const diffSets = (from, to) => [...to].filter((x) => !from.has(x)).sort();
      let filesAdded = [];
      let filesRemoved = [];
      let filesModified = [];
      if (crcA && crcB) {
        for (const n of crcB.keys()) if (!crcA.has(n)) filesAdded.push(n);
        for (const n of crcA.keys()) if (!crcB.has(n)) filesRemoved.push(n);
        for (const [n, c] of crcA) if (crcB.has(n) && crcB.get(n) !== c) filesModified.push(n);
        filesAdded.sort();
        filesRemoved.sort();
        filesModified.sort();
      }
      const cap = (arr, n = 60) =>
        arr.length > n ? { count: arr.length, sample: arr.slice(0, n) } : { count: arr.length, list: arr };

      return {
        apk_a: a,
        apk_b: b,
        version: {
          a: { name: ba?.version_name, code: ba?.version_code },
          b: { name: bb?.version_name, code: bb?.version_code },
        },
        permissions_added: diffSets(permsA, permsB),
        permissions_removed: diffSets(permsB, permsA),
        abis_added: diffSets(setA, setB),
        abis_removed: diffSets(setB, setA),
        files_added: cap(filesAdded),
        files_removed: cap(filesRemoved),
        files_modified: cap(filesModified),
        note:
          crcA && crcB
            ? "Perbandingan siap."
            : "Tidak dapat baca isi zip salah satu APK untuk diff fail (permission/ABI/versi masih dibanding).",
      };
    },
  });

  // ------------------------------------------------- reverse-engineering
  reg.register({
    name: "jadx_decompile",
    description: "Decompile an APK/DEX/JAR to readable Java source using jadx. Returns the output dir.",
    parameters: {
      type: "object",
      properties: { input: { type: "string" }, out_dir: { type: "string" } },
      required: ["input"],
    },
    handler: async (args, ctx) => {
      const p = resolve(args.input, ctx.workspace);
      if (!fs.existsSync(p)) return { error: `input not found: ${p}` };
      if (!which("jadx")) return { error: "jadx not installed — run install.sh" };
      const outDir = resolve(args.out_dir || `${stem(p)}.jadx`, ctx.workspace);
      const r = await run(["jadx", "-d", outDir, p]);
      r.out_dir = outDir;
      return r;
    },
  });

  reg.register({
    name: "dex2jar",
    description: "Convert a DEX/APK to a JAR using d2j-dex2jar. Returns the JAR path.",
    parameters: {
      type: "object",
      properties: { input: { type: "string" }, out_jar: { type: "string" } },
      required: ["input"],
    },
    handler: async (args, ctx) => {
      const p = resolve(args.input, ctx.workspace);
      if (!fs.existsSync(p)) return { error: `input not found: ${p}` };
      if (!which("d2j-dex2jar")) return { error: "dex2jar not installed — run install.sh" };
      const out = resolve(args.out_jar || `${stem(p)}.jar`, ctx.workspace);
      const r = await run(["d2j-dex2jar", p, "-o", out, "--force"]);
      r.out_jar = out;
      return r;
    },
  });

  reg.register({
    name: "strings",
    description: "Extract printable strings from a binary file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        min_len: { type: "number" },
        grep: { type: "string", description: "Only return lines matching this substring." },
      },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      const p = resolve(args.path, ctx.workspace);
      if (!fs.existsSync(p)) return { error: `not found: ${p}` };
      if (!which("strings")) return { error: "strings (binutils) not installed — run install.sh" };
      const cmd = `strings -n ${Number(args.min_len) || 4} ${shq(p)}` +
        (args.grep ? ` | grep -F ${shq(args.grep)}` : "") + " | head -n 4000";
      return runCommand({ command: cmd, timeout: 120000, maxChars: 15000 });
    },
  });

  reg.register({
    name: "hexdump",
    description: "Hexdump the first N bytes of a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, length: { type: "number" } },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      const p = resolve(args.path, ctx.workspace);
      if (!fs.existsSync(p)) return { error: `not found: ${p}` };
      const len = Number(args.length) || 512;
      return runCommand({ command: `xxd -l ${len} ${shq(p)} || hexdump -C -n ${len} ${shq(p)}`, timeout: 30000 });
    },
  });

  reg.register({
    name: "file_type",
    description: "Detect a file's type using the `file` command (libmagic).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      const p = resolve(args.path, ctx.workspace);
      if (!fs.existsSync(p)) return { error: `not found: ${p}` };
      if (!which("file")) return { error: "`file` not installed — run install.sh" };
      return run(["file", "-b", p], { timeout: 30000 });
    },
  });

  // ------------------------------------------------------- project build
  reg.register({
    name: "detect_project",
    description:
      "Detect the build system of a source project directory (Gradle, Flutter, React Native, apktool project, Unity export).",
    parameters: {
      type: "object",
      properties: { dir: { type: "string" } },
      required: ["dir"],
    },
    handler: async (args, ctx) => {
      const d = resolve(args.dir, ctx.workspace);
      if (!fs.existsSync(d)) return { error: `dir not found: ${d}` };
      const has = (rel) => fs.existsSync(path.join(d, rel));
      const types = [];
      if (has("pubspec.yaml")) types.push("flutter");
      if (has("package.json") && (has("android") || has("metro.config.js"))) types.push("react-native");
      if (has("settings.gradle") || has("settings.gradle.kts") || has("build.gradle") || has("gradlew"))
        types.push("gradle");
      if (has("apktool.yml")) types.push("apktool-project");
      if (has("Assets") && has("ProjectSettings")) types.push("unity");
      return { dir: d, types: types.length ? types : ["unknown"] };
    },
  });

  reg.register({
    name: "build_project",
    description:
      "Build an Android APK from a source project (auto-detects Gradle/Flutter/React Native/apktool). " +
      "By default builds a UNIVERSAL APK that bundles every common ABI (armeabi-v7a, arm64-v8a, x86, x86_64) " +
      "so the result installs on ARM 32/64-bit and x86 devices alike. Reports the produced APK(s) and their device compatibility. " +
      "Set universal=false (or pass abis) only when the user explicitly wants smaller, per-ABI splits.",
    parameters: {
      type: "object",
      properties: {
        dir: { type: "string" },
        variant: { type: "string", description: "release | debug (default release)" },
        universal: {
          type: "boolean",
          description:
            "Build one fat APK with all common ABIs so it installs everywhere (default true).",
        },
        abis: {
          type: "array",
          items: { type: "string" },
          description:
            "Explicit ABI list (e.g. armeabi-v7a,arm64-v8a,x86,x86_64). Defaults to all common ABIs.",
        },
      },
      required: ["dir"],
    },
    handler: async (args, ctx) => {
      const d = resolve(args.dir, ctx.workspace);
      if (!fs.existsSync(d)) return { error: `dir not found: ${d}` };
      const variant = (args.variant || "release").toLowerCase();
      const universal = args.universal !== false;
      const abis =
        Array.isArray(args.abis) && args.abis.length ? args.abis.map(String) : COMMON_ABIS.slice();
      const has = (rel) => fs.existsSync(path.join(d, rel));

      let cmd;
      let tool = "auto";
      if (has("pubspec.yaml")) {
        tool = "gradle"; // flutter drives gradle under the hood
        // `flutter build apk` (no --split-per-abi) already yields a universal
        // fat APK. Pin the target platforms so all common ABIs are included.
        const platforms = abis.map(flutterPlatform).filter(Boolean);
        const targetFlag =
          universal && platforms.length ? ` --target-platform ${[...new Set(platforms)].join(",")}` : "";
        cmd = `flutter build apk --${variant}${targetFlag}`;
      } else if (has("android/gradlew") || (has("package.json") && has("android"))) {
        // React Native: the Android project lives in ./android. RN respects the
        // `reactNativeArchitectures` gradle property — set it so the APK is
        // universal across ABIs.
        tool = "gradle";
        const archProp = universal ? ` -PreactNativeArchitectures=${abis.join(",")}` : "";
        cmd = `cd android && ./gradlew assemble${cap(variant)}${archProp}`;
      } else if (has("gradlew")) {
        tool = "gradle";
        const archProp = universal ? ` -PreactNativeArchitectures=${abis.join(",")}` : "";
        cmd = `./gradlew assemble${cap(variant)}${archProp}`;
      } else if (has("apktool.yml")) {
        tool = "apktool";
        cmd = `apktool b . -o build/out.unsigned.apk --use-aapt2`;
      } else {
        return { error: "could not detect a buildable project (no pubspec/gradlew/apktool.yml)" };
      }

      report(ctx, { percent: 3, label: "Build projek", ceil: 95 });
      const r = await runCommand({
        command: cmd,
        cwd: d,
        timeout: 1800000,
        maxChars: 15000,
        onData: progressParser(ctx, tool, 3, 95, "Build projek"),
      });
      report(ctx, { percent: 100, label: "Build siap" });

      // Find produced APKs.
      const apks = [];
      const stack = [d];
      while (stack.length) {
        const cur = stack.pop();
        let entries;
        try {
          entries = fs.readdirSync(cur, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const full = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.name.endsWith(".apk")) apks.push(full);
        }
      }
      r.apks = apks.slice(0, 20);
      r.build_command = cmd;
      r.universal_requested = universal;

      // Report compatibility per produced APK and highlight the best (most
      // universal) one to deliver.
      const compat = {};
      let best = null;
      let bestScore = -1;
      for (const a of r.apks) {
        const list = await apkAbis(a);
        const summary = list == null ? null : summarizeAbiCompatibility(list);
        compat[a] = summary;
        // Score: prefer no-native or both-ARM (universal), then ABI count.
        const score = summary
          ? (summary.universal ? 100 : 0) + summary.abis.length
          : 0;
        if (score > bestScore) {
          bestScore = score;
          best = a;
        }
      }
      r.compatibility = compat;
      r.recommended_apk = best;
      return r;
    },
  });
}

// Map an Android ABI to the `flutter build apk --target-platform` token.
function flutterPlatform(abi) {
  switch (abi) {
    case "armeabi-v7a":
      return "android-arm";
    case "arm64-v8a":
      return "android-arm64";
    case "x86_64":
      return "android-x64";
    case "x86":
      return null; // flutter dropped 32-bit x86 support; skip it.
    default:
      return null;
  }
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function shq(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}
