// Shared helpers for tool handlers.

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// Resolve a (possibly relative) path against the per-user workspace.
export function resolvePath(p, workspace) {
  if (!p) return workspace;
  return path.isAbsolute(p) ? p : path.join(workspace, p);
}

// Run a command. If `shell` is true, runs via `bash -c command`; otherwise
// spawns argv directly. Captures stdout/stderr, enforces a timeout, and trims
// very large output. `onData(chunk, stream)` (optional) is called with each
// stdout/stderr chunk as it arrives — handy for live build-progress parsing.
export function runCommand({
  command,
  argv,
  cwd,
  timeout = 180000,
  env,
  maxChars = 20000,
  onData,
}) {
  return new Promise((resolve) => {
    let child;
    const opts = {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
    };
    try {
      if (command != null) {
        child = spawn("bash", ["-c", command], opts);
      } else {
        child = spawn(argv[0], argv.slice(1), opts);
      }
    } catch (e) {
      resolve({ error: `spawn failed: ${e.message}`, command, argv });
      return;
    }

    let out = "";
    let err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeout);

    const safeOnData = (chunk, stream) => {
      if (!onData) return;
      try {
        onData(chunk, stream);
      } catch {
        /* progress callbacks must never break the command */
      }
    };
    child.stdout?.on("data", (d) => {
      const s = d.toString();
      out += s;
      if (out.length > maxChars * 2) out = out.slice(-maxChars * 2);
      safeOnData(s, "stdout");
    });
    child.stderr?.on("data", (d) => {
      const s = d.toString();
      err += s;
      if (err.length > maxChars * 2) err = err.slice(-maxChars * 2);
      safeOnData(s, "stderr");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ error: `command failed: ${e.message}`, command, argv });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const trim = (s) =>
        s.length <= maxChars ? s : "…[trimmed head]…\n" + s.slice(-maxChars);
      if (killed) {
        resolve({
          error: `timeout after ${timeout / 1000}s`,
          stdout: trim(out),
          stderr: trim(err),
          command,
          argv,
        });
        return;
      }
      resolve({
        command,
        argv,
        cwd,
        exit_code: code,
        stdout: trim(out),
        stderr: trim(err),
        truncated: out.length > maxChars || err.length > maxChars,
      });
    });
  });
}

export function which(name) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const d of dirs) {
    const full = path.join(d, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// OCR (read text out of screenshots so the AI can diagnose error images even
// when the selected model has no vision support).
// --------------------------------------------------------------------------

// Run tesseract OCR over an image and return the recognised text. Resolves to
// { ok, text } on success or { ok:false, error } when tesseract is missing or
// fails. Never throws.
export function ocrImage(imagePath, { lang, timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const bin = which("tesseract");
    if (!bin) {
      resolve({ ok: false, error: "tesseract not installed — run install.sh to enable OCR" });
      return;
    }
    if (!fs.existsSync(imagePath)) {
      resolve({ ok: false, error: `image not found: ${imagePath}` });
      return;
    }
    // `tesseract <img> stdout` prints the recognised text to stdout.
    const argv = [imagePath, "stdout"];
    if (lang) argv.push("-l", lang);
    runCommand({ argv: [bin, ...argv], timeout, maxChars: 20000 }).then((r) => {
      if (r.error || r.exit_code !== 0) {
        resolve({ ok: false, error: r.error || r.stderr || "tesseract failed" });
        return;
      }
      const text = (r.stdout || "").trim();
      resolve({ ok: true, text });
    });
  });
}

// --------------------------------------------------------------------------
// Build-progress parsing
// --------------------------------------------------------------------------
//
// Build tools print progress in their own formats. parseBuildProgress reads a
// chunk of stdout/stderr and returns a 0-100 number when it can recognise a
// stage, or null otherwise. Callers map that into the chat status card. The
// numbers are mapped into the [floor, ceil] window of the current phase so the
// overall bar only moves forward.

// Map a fraction (0..1) into a [floor, ceil] window.
export function spanPercent(fraction, floor, ceil) {
  const f = Math.max(0, Math.min(1, fraction));
  return Math.round(floor + (ceil - floor) * f);
}

// Gradle prints a live progress line like `<=======------> 55% EXECUTING`.
const GRADLE_PCT = /(\d{1,3})%\s+(?:EXECUTING|INITIALIZING|CONFIGURING|WAITING)/i;

// apktool builds in recognisable ordered stages (it prints `I: ...` lines).
const APKTOOL_STAGES = [
  { re: /Using Apktool/i, frac: 0.05 },
  { re: /Checking whether sources|Smaling|Building smali|building dex/i, frac: 0.3 },
  { re: /Building resources/i, frac: 0.55 },
  { re: /Copying (?:libs|original|unknown|raw|res|assets)/i, frac: 0.7 },
  { re: /Building apk file/i, frac: 0.85 },
  { re: /Copying unknown files|Built apk|Building unknown/i, frac: 0.95 },
];

// Returns { fraction } in 0..1 for the latest recognised stage in `chunk`, or
// null. `tool` selects the parser ("gradle" | "apktool" | "auto").
export function parseBuildProgress(chunk, tool = "auto") {
  const text = String(chunk || "");
  if (!text) return null;

  if (tool === "gradle" || tool === "auto") {
    let m;
    let last = null;
    const re = new RegExp(GRADLE_PCT.source, "ig");
    while ((m = re.exec(text))) last = m;
    if (last) {
      const pct = Math.max(0, Math.min(100, parseInt(last[1], 10)));
      return { fraction: pct / 100 };
    }
  }

  if (tool === "apktool" || tool === "auto") {
    let best = null;
    for (const st of APKTOOL_STAGES) {
      if (st.re.test(text)) best = best == null ? st.frac : Math.max(best, st.frac);
    }
    if (best != null) return { fraction: best };
  }

  return null;
}

// --------------------------------------------------------------------------
// ABI / device-compatibility helpers (used for "smart", universal builds)
// --------------------------------------------------------------------------

// Common Android ABIs we try to ship so an APK installs on the widest range of
// devices: 32-bit ARM, 64-bit ARM, and the (rarer) x86 emulator/Chromebook set.
export const COMMON_ABIS = ["armeabi-v7a", "arm64-v8a", "x86", "x86_64"];

// Friendly description per ABI.
const ABI_LABELS = {
  "armeabi-v7a": "ARM 32-bit (kebanyakan telefon lama)",
  "arm64-v8a": "ARM 64-bit (kebanyakan telefon moden)",
  x86: "x86 32-bit (emulator/Chromebook)",
  x86_64: "x86 64-bit (emulator/Chromebook)",
};

// Given the list of ABIs present in an APK, summarise how compatible it is.
// `null`/empty ABIs means the APK has no native libs and runs on every device.
export function summarizeAbiCompatibility(abis) {
  const list = Array.isArray(abis) ? abis.filter(Boolean) : [];
  const set = new Set(list);
  const hasArm32 = set.has("armeabi-v7a");
  const hasArm64 = set.has("arm64-v8a");
  const noNative = list.length === 0;
  // "Universal" = installs on the common device spread: either no native code,
  // or it bundles both 32- and 64-bit ARM.
  const universal = noNative || (hasArm32 && hasArm64);
  const missing = COMMON_ABIS.filter((a) => !set.has(a));
  const notes = noNative
    ? "Tiada kod native — boleh dipasang pada semua peranti (ARM 32/64, x86)."
    : universal
      ? "Sokong ARM 32-bit & 64-bit — boleh dipasang pada hampir semua telefon Android."
      : `Hanya ${list.join(", ") || "(tiada)"} — sesetengah peranti mungkin tidak boleh pasang.`;
  return {
    abis: list,
    universal,
    has_arm32: hasArm32,
    has_arm64: hasArm64,
    no_native: noNative,
    missing_common_abis: missing,
    labels: list.map((a) => ABI_LABELS[a] || a),
    notes,
  };
}
