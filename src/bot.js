// Suzu-JS Telegram bot: professional, per-user, unlimited.
//
// - One private workspace + persistent chat memory per Telegram user.
// - /start shows a Kali-style banner + inline menu (Pilih Model / Bantuan /
//   Status / Reset). Model picker is built from the live /models list.
// - Live animation (spinner status card) while the agent thinks / runs tools.
// - Uploaded files (any type) land in the user's folder; images are forwarded
//   to vision-capable models. APK uploads get quick action buttons.
// - No request/usage limits.

import fs from "node:fs";
import path from "node:path";

import { loadConfig, saveEnv } from "./config.js";
import { ChatClient } from "./api.js";
import { TelegramAPI } from "./telegram.js";
import { UserStore } from "./store.js";
import { buildRegistry } from "./tools/index.js";
import { runTurn } from "./agent.js";
import { renderSystemPrompt } from "./prompts.js";
import { fetchModels, isVisionModel, FALLBACK_MODELS } from "./models.js";
import { FileServer } from "./fileserver.js";
import { ocrImage, which } from "./tools/util.js";
import os from "node:os";

// Instruction attached to uploaded images so the AI actually diagnoses the
// problem in a screenshot (the common case: a user screenshots an error).
const IMAGE_ANALYSIS_PROMPT =
  "Pengguna menghantar gambar/screenshot (selalunya paparan RALAT/error). " +
  "Anda ADA dua sumber: gambar itu sendiri DAN teks OCR di bawah — guna KEDUA-DUANYA dan saling semak untuk ketepatan tinggi. " +
  "Langkah: " +
  "(1) Petik teks ralat TEPAT seperti tertera (mesej penuh, kod ralat, stack trace, nama fail & nombor baris). " +
  "(2) Kenal pasti PUNCA SEBENAR (root cause), bukan sekadar gejala. " +
  "(3) Beri penyelesaian KONKRIT langkah demi langkah, termasuk arahan/command tepat untuk dijalankan jika ada. " +
  "(4) Jika teks kabur/terpotong atau OCR bercanggah dengan gambar, percaya gambar dan nyatakan apa yang anda nampak; " +
  "jika maklumat masih tak cukup untuk pasti, tanya SATU soalan ringkas. " +
  "JANGAN reka maklumat yang tiada dalam gambar.";

const PHASE_LABELS = {
  shell: "Menjalankan arahan",
  exec: "Menjalankan proses",
  read_file: "Membaca fail",
  write_file: "Menulis fail",
  edit_file: "Menyunting fail",
  list_dir: "Menyemak fail",
  glob: "Mencari fail",
  grep: "Mencari dalam kod",
  mkdir: "Membuat folder",
  move: "Memindah fail",
  remove: "Memadam fail",
  deliver: "Menyiapkan hasil akhir",
  detect_apk_type: "Menganalisis APK",
  apk_decompile: "Decompile APK",
  apk_recompile: "Recompile APK",
  apk_zipalign: "Zipalign APK",
  apk_sign: "Menandatangani APK",
  apk_verify_signature: "Mengesahkan tandatangan",
  apk_aapt_dump: "Membaca manifest/badging",
  apk_build_full: "Build + sign APK",
  jadx_decompile: "Decompile (jadx)",
  dex2jar: "Menukar DEX ke JAR",
  strings: "Mengekstrak strings",
  hexdump: "Hexdump",
  file_type: "Mengesan jenis fail",
  detect_project: "Mengesan jenis projek",
  build_project: "Build projek",
  ocr_image: "Membaca teks dalam gambar (OCR)",
  verify_apk: "Mengesahkan APK",
  update_plan: "Mengemas kini pelan",
  apk_audit: "Mengaudit keselamatan APK",
  apk_diff: "Membanding dua APK",
};

function phaseLabel(name) {
  return PHASE_LABELS[name] || `Menjalankan ${name}`;
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

export class SuzuBot {
  constructor() {
    this.cfg = loadConfig();
    this.client = new ChatClient({
      baseUrl: this.cfg.apiBaseUrl,
      apiKey: this.cfg.apiKey,
      timeout: this.cfg.requestTimeout,
    });
    this.tg = new TelegramAPI(this.cfg.telegramToken);
    this.store = new UserStore(this.cfg.usersDir);
    this.registry = buildRegistry();
    this.models = FALLBACK_MODELS.slice();
    this.pendingApk = new Map(); // userId -> filepath awaiting an action choice
    this.pendingFile = new Map(); // userId -> non-APK filepath awaiting a choice
    this.pendingDiff = new Map(); // userId -> first APK path awaiting a second to diff
    this.busy = new Set(); // userIds with a turn in flight
    this.running = false;
    this.offset = 0;
    this.fileServer = this.cfg.httpEnable
      ? new FileServer(this.store, { port: this.cfg.httpPort, publicUrl: this.cfg.publicUrl })
      : null;
  }

  // Host used to build download links when no public URL is configured.
  linkHost() {
    if (this.cfg.publicHost) return `${this.cfg.publicHost}:${this.cfg.httpPort}`;
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name] || []) {
        if (ni.family === "IPv4" && !ni.internal) return `${ni.address}:${this.cfg.httpPort}`;
      }
    }
    return `127.0.0.1:${this.cfg.httpPort}`;
  }

  downloadLink(userId) {
    const meta = this.store.getMeta(userId);
    if (!meta) return null;
    return this.fileServer
      ? this.fileServer.linkFor(userId, meta.download_token, this.linkHost())
      : null;
  }

  isAllowed(userId) {
    if (!this.cfg.allowedUserIds.length) return true;
    return this.cfg.allowedUserIds.includes(String(userId));
  }
  isAdmin(userId) {
    if (this.cfg.adminUserIds.length) return this.cfg.adminUserIds.includes(String(userId));
    // No explicit admin list → first allowed user, or anyone if open.
    return this.isAllowed(userId);
  }

  // Effective access state for a user. Admins are always approved. When
  // approval mode is off, everyone (allowed) is approved by default.
  userStatus(userId, meta) {
    if (this.isAdmin(userId)) return "approved";
    const s = (meta || this.store.getMeta(userId) || {}).status;
    if (s === "banned" || s === "approved" || s === "pending") return s;
    return this.cfg.requireApproval ? "pending" : "approved";
  }

  // Notify every configured admin (in their private chat) about a pending user.
  async notifyAdminsNewUser(meta) {
    const uname = meta.username ? `@${meta.username}` : meta.first_name || "(tiada nama)";
    const text = [
      "🔔 *Permintaan akses baharu*",
      `Nama: ${escapeMd(uname)}`,
      `ID: \`${meta.id}\``,
      "",
      "Luluskan pengguna ini?",
    ].join("\n");
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `adm:approve:${meta.id}` },
          { text: "⛔ Ban", callback_data: `adm:ban:${meta.id}` },
        ],
      ],
    };
    for (const adminId of this.cfg.adminUserIds) {
      try {
        await this.tg.sendMessage(adminId, text, { parseMode: "Markdown", replyMarkup });
      } catch {
        /* admin may not have opened the bot yet */
      }
    }
  }

  // Approve / ban / unban a target user and tell them.
  async setUserStatus(targetId, status) {
    this.store.ensureUser(targetId, { defaultModel: this.cfg.defaultModel });
    this.store.setStatus(targetId, status);
    const notice =
      status === "approved"
        ? "✅ Akses anda telah *diluluskan*! Taip /start untuk mula."
        : status === "banned"
          ? "⛔ Akses anda telah *disekat* oleh admin."
          : null;
    if (notice) {
      try {
        await this.tg.sendMessage(targetId, notice, { parseMode: "Markdown" });
      } catch {
        /* target may not be reachable */
      }
    }
  }

  // Gate a non-approved user. Returns true if the message was handled here and
  // the caller should stop. /start, /id and /help always pass through.
  async gateAccess(chatId, userId, text, meta) {
    const status = this.userStatus(userId, meta);
    if (status === "banned") {
      await this.tg.sendMessage(chatId, "⛔ Maaf, akses anda telah disekat oleh admin.");
      return true;
    }
    if (status === "approved") return false;

    // status === "pending" → record it once, notify admins, and allow only a
    // couple of harmless commands through.
    if (meta.status !== "pending") {
      this.store.setStatus(userId, "pending");
      meta.status = "pending";
      await this.notifyAdminsNewUser(this.store.getMeta(userId));
    }
    const cmd = text.startsWith("/") ? text.split(/\s+/)[0].replace(/@.*$/, "").toLowerCase() : "";
    if (cmd === "/start" || cmd === "/id" || cmd === "/help") return false;

    await this.tg.sendMessage(
      chatId,
      [
        "⏳ *Menunggu kelulusan admin.*",
        `ID Telegram anda: \`${userId}\``,
        "",
        this.cfg.adminUserIds.length
          ? "Admin sudah dimaklumkan. Sila tunggu sebentar."
          : "Belum ada admin ditetapkan. Beritahu pemilik bot untuk jalankan `suzu admin add " +
            userId +
            "`.",
      ].join("\n"),
      { parseMode: "Markdown" },
    );
    return true;
  }

  async start() {
    if (!this.cfg.telegramToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is not set — run `suzu config`.");
    }
    const me = await this.tg.getMe();
    this.cfg.telegramBotUsername = me.username || this.cfg.telegramBotUsername;
    log(`Bot @${me.username} online. API: ${this.cfg.apiBaseUrl}`);
    // Best-effort: refresh live model list.
    this.models = await fetchModels(this.cfg);
    log(`${this.models.length} models available. Default: ${this.cfg.defaultModel}`);
    // Capability banner so it's obvious from the logs whether the latest
    // screenshot-reading code is running (helps diagnose stale deployments).
    const ocrReady = !!which("tesseract");
    log(
      `Image diagnosis: vision=${this.cfg.enableVision ? "on" : "off"}, ` +
        `OCR(tesseract)=${ocrReady ? "ready" : "MISSING — run install.sh"}`,
    );
    if (this.fileServer) {
      this.fileServer.start();
      log(`Download server on port ${this.cfg.httpPort} (link host: ${this.linkHost()})`);
    }

    this.running = true;
    while (this.running) {
      let updates;
      try {
        updates = await this.tg.getUpdates(this.offset, 30);
      } catch (e) {
        log(`getUpdates error: ${e.message}`);
        await sleep(2000);
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        this.handleUpdate(u).catch((e) => log(`handler error: ${e.stack || e}`));
      }
    }
  }

  stop() {
    this.running = false;
    if (this.fileServer) this.fileServer.stop();
  }

  async handleUpdate(u) {
    if (u.callback_query) return this.handleCallback(u.callback_query);
    if (u.message) return this.handleMessage(u.message);
  }

  // ----------------------------------------------------------- messages
  async handleMessage(msg) {
    const chatId = msg.chat.id;
    const from = msg.from || {};
    const userId = from.id;
    if (!this.isAllowed(userId)) {
      await this.tg.sendMessage(chatId, "⛔ Maaf, anda tidak dibenarkan menggunakan bot ini.");
      return;
    }
    const meta = this.store.ensureUser(userId, {
      username: from.username,
      firstName: from.first_name,
      defaultModel: this.cfg.defaultModel,
    });

    const text = (msg.text || msg.caption || "").trim();

    // Approval / ban gate (no-op when approval mode is off and user not banned).
    if (await this.gateAccess(chatId, userId, text, meta)) return;

    // Slash commands.
    if (text.startsWith("/")) {
      const handled = await this.handleCommand(chatId, userId, text, msg);
      if (handled) return;
    }

    // File / photo uploads.
    const fileInfo = this.extractFile(msg);
    if (fileInfo) {
      await this.handleUpload(chatId, userId, msg, fileInfo, text);
      return;
    }

    if (!text) return;
    await this.routeToAgent(chatId, userId, text, { replyTo: msg.message_id });
  }

  async handleCommand(chatId, userId, text, msg) {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.replace(/@.*$/, "").toLowerCase();
    const arg = rest.join(" ").trim();

    switch (cmd) {
      case "/start": {
        await this.sendWelcome(chatId, userId);
        return true;
      }
      case "/help": {
        await this.tg.sendMessage(chatId, this.helpText(userId), { parseMode: "Markdown" });
        return true;
      }
      case "/menu": {
        await this.sendMenu(chatId, userId);
        return true;
      }
      case "/model":
      case "/models": {
        if (arg) {
          this.store.setMeta(userId, { model: arg });
          const s = this.store.loadSession(userId, this.cfg.defaultModel);
          s.model = arg;
          this.store.saveSession(userId, s);
          await this.tg.sendMessage(chatId, `✅ Model ditetapkan: \`${arg}\``, { parseMode: "Markdown" });
        } else {
          await this.sendModelPicker(chatId, userId);
        }
        return true;
      }
      case "/reset": {
        this.store.resetSession(userId);
        await this.tg.sendMessage(chatId, "🧹 Memori chat dikosongkan. Fail anda tetap tersimpan.");
        return true;
      }
      case "/new": {
        this.store.resetSession(userId);
        await this.tg.sendMessage(chatId, "🆕 Sesi baharu dimulakan.");
        return true;
      }
      case "/memory":
      case "/ingat": {
        // `/memory clear` wipes it; `/memory forget <text>` removes matches;
        // otherwise list saved facts.
        const sub = (arg || "").trim();
        if (/^clear$/i.test(sub)) {
          this.store.clearMemory(userId);
          await this.tg.sendMessage(chatId, "🧠 Memori jangka panjang dikosongkan.");
          return true;
        }
        const m = sub.match(/^forget\s+(.+)$/i);
        if (m) {
          const removed = this.store.removeMemory(userId, m[1].trim());
          await this.tg.sendMessage(chatId, removed ? `🗑️ Dibuang ${removed} memori.` : "Tiada memori sepadan.");
          return true;
        }
        const items = this.store.loadMemory(userId);
        if (!items.length) {
          await this.tg.sendMessage(
            chatId,
            "🧠 Tiada memori lagi. Beritahu saya keutamaan anda (cth \"selalu build arm64 sahaja\") dan saya akan ingat.",
          );
          return true;
        }
        const body = items.map((it, i) => `${i + 1}. ${it.text}`).join("\n");
        await this.tg.sendMessage(
          chatId,
          `🧠 *Memori jangka panjang:*\n${body}\n\n_/memory forget <teks>_ untuk buang, _/memory clear_ untuk kosongkan.`,
          { parseMode: "Markdown" },
        );
        return true;
      }
      case "/status": {
        await this.tg.sendMessage(chatId, await this.statusText(userId), { parseMode: "Markdown" });
        return true;
      }
      case "/files":
      case "/workspace": {
        await this.tg.sendMessage(chatId, this.filesText(userId), { parseMode: "Markdown" });
        return true;
      }
      case "/download":
      case "/dl": {
        await this.sendDownloadInfo(chatId, userId);
        return true;
      }
      case "/sftp": {
        await this.tg.sendMessage(chatId, this.sftpText(userId), { parseMode: "Markdown" });
        return true;
      }
      case "/setapi": {
        if (!this.isAdmin(userId)) {
          await this.tg.sendMessage(chatId, "⛔ Hanya admin boleh tukar API.");
          return true;
        }
        const parts = arg.split(/\s+/).filter(Boolean);
        if (!parts.length) {
          await this.tg.sendMessage(
            chatId,
            "Cara guna: `/setapi <base_url> [api_key]`\nContoh: `/setapi https://api.cybersecdev.cloud/v1 fiq-xxxx`",
            { parseMode: "Markdown" },
          );
          return true;
        }
        const updates = { AI_API_BASE_URL: parts[0].replace(/\/+$/, "") };
        if (parts[1]) updates.AI_API_KEY = parts[1];
        saveEnv(updates, this.cfg.envFile);
        this.cfg.apiBaseUrl = updates.AI_API_BASE_URL;
        if (updates.AI_API_KEY) this.cfg.apiKey = updates.AI_API_KEY;
        this.client.reconfigure({ baseUrl: this.cfg.apiBaseUrl, apiKey: this.cfg.apiKey });
        this.models = await fetchModels(this.cfg);
        await this.tg.sendMessage(
          chatId,
          `✅ API dikemaskini.\nBase URL: \`${this.cfg.apiBaseUrl}\`\nModel tersedia: ${this.models.length}`,
          { parseMode: "Markdown" },
        );
        return true;
      }
      case "/id":
      case "/whoami": {
        const m = this.store.getMeta(userId);
        await this.tg.sendMessage(
          chatId,
          [
            "🪪 *Maklumat anda*",
            `ID Telegram: \`${userId}\``,
            m?.username ? `Username: @${escapeMd(m.username)}` : null,
            `Status: ${statusBadge(this.userStatus(userId, m))}`,
            this.isAdmin(userId) ? "Peranan: *Admin* 🛡️" : null,
          ]
            .filter(Boolean)
            .join("\n"),
          { parseMode: "Markdown" },
        );
        return true;
      }
      case "/admin": {
        if (!this.requireAdmin(chatId, userId)) return true;
        await this.sendAdminPanel(chatId);
        return true;
      }
      case "/users": {
        if (!this.requireAdmin(chatId, userId)) return true;
        await this.sendUsersList(chatId);
        return true;
      }
      case "/pending": {
        if (!this.requireAdmin(chatId, userId)) return true;
        await this.sendPendingList(chatId);
        return true;
      }
      case "/approve":
      case "/ban":
      case "/unban": {
        if (!this.requireAdmin(chatId, userId)) return true;
        const target = arg.split(/\s+/)[0].replace(/^@/, "");
        if (!target) {
          await this.tg.sendMessage(chatId, `Cara guna: \`${cmd} <telegram_id>\``, { parseMode: "Markdown" });
          return true;
        }
        const status = cmd === "/approve" ? "approved" : cmd === "/ban" ? "banned" : "approved";
        await this.setUserStatus(target, status);
        const word = cmd === "/ban" ? "disekat ⛔" : cmd === "/unban" ? "dibuka semula ✅" : "diluluskan ✅";
        await this.tg.sendMessage(chatId, `Pengguna \`${target}\` telah ${word}.`, { parseMode: "Markdown" });
        return true;
      }
      case "/chat": {
        if (!this.requireAdmin(chatId, userId)) return true;
        const parts = arg.split(/\s+/).filter(Boolean);
        if (!parts.length) {
          await this.tg.sendMessage(chatId, "Cara guna: `/chat <telegram_id> [bilangan]`", { parseMode: "Markdown" });
          return true;
        }
        await this.sendUserChat(chatId, parts[0].replace(/^@/, ""), parseInt(parts[1] || "20", 10));
        return true;
      }
      case "/userfiles": {
        if (!this.requireAdmin(chatId, userId)) return true;
        const target = arg.split(/\s+/)[0].replace(/^@/, "");
        if (!target) {
          await this.tg.sendMessage(chatId, "Cara guna: `/userfiles <telegram_id>`", { parseMode: "Markdown" });
          return true;
        }
        await this.sendUserFiles(chatId, target);
        return true;
      }
      default:
        return false; // unknown slash → let it reach the agent as text
    }
  }

  requireAdmin(chatId, userId) {
    if (this.isAdmin(userId)) return true;
    this.tg.sendMessage(chatId, "⛔ Arahan ini untuk admin sahaja.");
    return false;
  }

  // ----------------------------------------------------------- callbacks
  async handleCallback(cq) {
    const data = cq.data || "";
    const chatId = cq.message?.chat?.id;
    const userId = cq.from?.id;
    if (!this.isAllowed(userId)) {
      await this.tg.answerCallbackQuery(cq.id, "Tidak dibenarkan");
      return;
    }
    this.store.ensureUser(userId, {
      username: cq.from?.username,
      firstName: cq.from?.first_name,
      defaultModel: this.cfg.defaultModel,
    });

    // Admin actions (approve/ban from notifications + admin panel buttons).
    if (data.startsWith("adm:")) {
      if (!this.isAdmin(userId)) {
        await this.tg.answerCallbackQuery(cq.id, "Admin sahaja");
        return;
      }
      const [, action, target] = data.split(":");
      if (action === "approve" || action === "ban" || action === "unban") {
        const status = action === "ban" ? "banned" : "approved";
        await this.setUserStatus(target, status);
        const word = action === "ban" ? "disekat ⛔" : action === "unban" ? "dibuka ✅" : "diluluskan ✅";
        await this.tg.answerCallbackQuery(cq.id, `Pengguna ${target} ${word}`);
        await this.tg.sendMessage(chatId, `Pengguna \`${target}\` telah ${word}.`, { parseMode: "Markdown" });
        return;
      }
      if (action === "users") {
        await this.tg.answerCallbackQuery(cq.id);
        await this.sendUsersList(chatId);
        return;
      }
      if (action === "pending") {
        await this.tg.answerCallbackQuery(cq.id);
        await this.sendPendingList(chatId);
        return;
      }
      if (action === "chat") {
        await this.tg.answerCallbackQuery(cq.id);
        await this.sendUserChat(chatId, target, 20);
        return;
      }
      if (action === "files") {
        await this.tg.answerCallbackQuery(cq.id);
        await this.sendUserFiles(chatId, target);
        return;
      }
      await this.tg.answerCallbackQuery(cq.id);
      return;
    }

    if (data === "menu:admin") {
      await this.tg.answerCallbackQuery(cq.id);
      if (!this.isAdmin(userId)) {
        await this.tg.sendMessage(chatId, "⛔ Arahan ini untuk admin sahaja.");
        return;
      }
      await this.sendAdminPanel(chatId);
      return;
    }

    if (data === "menu:models") {
      await this.tg.answerCallbackQuery(cq.id);
      await this.sendModelPicker(chatId, userId);
      return;
    }
    if (data === "menu:help") {
      await this.tg.answerCallbackQuery(cq.id);
      await this.tg.sendMessage(chatId, this.helpText(userId), { parseMode: "Markdown" });
      return;
    }
    if (data === "menu:status") {
      await this.tg.answerCallbackQuery(cq.id);
      await this.tg.sendMessage(chatId, await this.statusText(userId), { parseMode: "Markdown" });
      return;
    }
    if (data === "menu:download") {
      await this.tg.answerCallbackQuery(cq.id);
      await this.sendDownloadInfo(chatId, userId);
      return;
    }
    if (data === "menu:reset") {
      this.store.resetSession(userId);
      await this.tg.answerCallbackQuery(cq.id, "Memori dikosongkan");
      await this.tg.sendMessage(chatId, "🧹 Memori chat dikosongkan.");
      return;
    }
    if (data.startsWith("model:")) {
      const id = data.slice("model:".length);
      this.store.setMeta(userId, { model: id });
      const s = this.store.loadSession(userId, this.cfg.defaultModel);
      s.model = id;
      this.store.saveSession(userId, s);
      await this.tg.answerCallbackQuery(cq.id, `Model: ${id}`);
      await this.tg.sendMessage(chatId, `✅ Model ditetapkan: \`${id}\``, { parseMode: "Markdown" });
      return;
    }
    if (data.startsWith("apk:")) {
      const action = data.slice("apk:".length);
      await this.tg.answerCallbackQuery(cq.id);
      const file = this.pendingApk.get(userId);
      if (!file) {
        await this.tg.sendMessage(chatId, "Fail APK tidak dijumpai lagi, sila hantar semula.");
        return;
      }
      // "Diff" needs a second APK — stash this one and wait for the next upload.
      if (action === "diff") {
        this.pendingApk.delete(userId);
        this.pendingDiff.set(userId, file);
        await this.tg.sendMessage(
          chatId,
          `📊 Hantar APK *kedua* untuk dibandingkan dengan \`${path.basename(file)}\`.`,
          { parseMode: "Markdown" },
        );
        return;
      }
      this.pendingApk.delete(userId);
      const map = {
        analyze: `Analisis penuh APK ini (framework, package, permission, library): ${file}`,
        audit:
          `Jalankan audit keselamatan & privasi APK ini guna tool apk_audit — senaraikan permission (tanda yang bahaya), ` +
          `kesan tracker/SDK, status debuggable & tandatangan, dan keserasian ABI. Ringkaskan sama ada selamat: ${file}`,
        decompile: `Decompile APK ini dengan apktool dan ringkaskan strukturnya: ${file}`,
        fix:
          `Periksa APK ini dan baiki masalah biasa (cth tak boleh install, ABI tak serasi, tandatangan rosak/tiada). ` +
          `Decompile jika perlu, betulkan, kemudian rebuild & sign supaya boleh dipasang: ${file}`,
        build: `Recompile/rebuild APK dari sumber ini dan hasilkan APK yang ditandatangani: ${file}`,
        modify: `Saya mahu ubah suai APK ini. Decompile dulu, kemudian tanya saya bahagian apa yang nak diubah: ${file}`,
        aab:
          `Tukar fail AAB ini menjadi APK universal yang boleh dipasang guna tool aab_to_apk, ` +
          `kemudian sahkan (verify_apk) dan deliver APK akhir. Lapor pada peranti mana ia boleh dipasang: ${file}`,
      };
      await this.routeToAgent(chatId, userId, map[action] || `Proses APK: ${file}`);
      return;
    }
    if (data.startsWith("file:")) {
      const action = data.slice("file:".length);
      await this.tg.answerCallbackQuery(cq.id);
      const file = this.pendingFile.get(userId);
      if (!file) {
        await this.tg.sendMessage(chatId, "Fail tidak dijumpai lagi, sila hantar semula.");
        return;
      }
      this.pendingFile.delete(userId);
      const map = {
        analyze: `Analisis kandungan fail ini dan terangkan apa isinya: ${file}`,
        scan: `Periksa fail ini untuk ralat/isu/amaran dan cadangkan pembetulan yang konkrit: ${file}`,
        summary: `Ringkaskan kandungan fail ini secara padat dan jelas: ${file}`,
      };
      await this.routeToAgent(chatId, userId, map[action] || `Analisis fail: ${file}`);
      return;
    }
    await this.tg.answerCallbackQuery(cq.id);
  }

  // ----------------------------------------------------------- uploads
  extractFile(msg) {
    if (Array.isArray(msg.photo) && msg.photo.length) {
      const best = msg.photo[msg.photo.length - 1];
      return { fileId: best.file_id, name: `photo_${best.file_unique_id}.jpg`, isPhoto: true, size: best.file_size };
    }
    if (msg.document) {
      return { fileId: msg.document.file_id, name: msg.document.file_name || `file_${Date.now()}`, size: msg.document.file_size };
    }
    if (msg.video) return { fileId: msg.video.file_id, name: msg.video.file_name || `video_${Date.now()}.mp4`, size: msg.video.file_size };
    if (msg.audio) return { fileId: msg.audio.file_id, name: msg.audio.file_name || `audio_${Date.now()}.mp3`, size: msg.audio.file_size };
    if (msg.voice) return { fileId: msg.voice.file_id, name: `voice_${Date.now()}.ogg`, size: msg.voice.file_size };
    return null;
  }

  async handleUpload(chatId, userId, msg, fileInfo, caption) {
    if (fileInfo.size && fileInfo.size > 20 * 1024 * 1024) {
      await this.tg.sendMessage(
        chatId,
        "⚠️ Fail melebihi had muat-turun Telegram Bot API (20 MB). Sila hantar fail yang lebih kecil atau guna pautan.",
      );
      return;
    }
    const ext0 = path.extname(fileInfo.name).toLowerCase();
    const isApk = ext0 === ".apk" || ext0 === ".aab" || ext0 === ".xapk";
    const destDir = isApk ? this.store.apkDir(userId) : this.store.filesDir(userId);
    const dest = path.join(destDir, safeName(fileInfo.name));
    await this.tg.sendChatAction(chatId, "upload_document");
    try {
      await this.tg.downloadFile(fileInfo.fileId, dest);
    } catch (e) {
      await this.tg.sendMessage(chatId, `❌ Gagal memuat turun fail: ${e.message}`);
      return;
    }
    const ext = path.extname(dest).toLowerCase();

    // APK → professional quick-action buttons.
    if (ext === ".apk" || ext === ".aab" || ext === ".xapk") {
      // Waiting for a second APK to diff against the first one.
      const diffBase = this.pendingDiff.get(userId);
      if (diffBase) {
        this.pendingDiff.delete(userId);
        await this.routeToAgent(
          chatId,
          userId,
          `Banding dua APK ini guna tool apk_diff dan ringkaskan perbezaan (versi, permission, ABI, fail berubah). ` +
            `APK A: ${diffBase}\nAPK B: ${dest}`,
        );
        return;
      }
      // If the user already said what to do (caption), act directly — don't be rigid.
      if (caption && caption.trim()) {
        await this.routeToAgent(chatId, userId, `${caption.trim()}\n\nFail APK: ${dest}`, {
          replyTo: msg.message_id,
        });
        return;
      }
      this.pendingApk.set(userId, dest);
      // An AAB can't be installed directly — lead with the convert action.
      if (ext === ".aab") {
        await this.tg.sendMessage(
          chatId,
          `📦 AAB diterima: \`${path.basename(dest)}\`\nAAB tak boleh dipasang terus. Nak buat apa?`,
          {
            parseMode: "Markdown",
            replyMarkup: {
              inline_keyboard: [
                [{ text: "📦 Jadi APK universal (boleh install)", callback_data: "apk:aab" }],
                [
                  { text: "🔍 Analisis", callback_data: "apk:analyze" },
                  { text: "🔐 Audit", callback_data: "apk:audit" },
                ],
              ],
            },
          },
        );
        return;
      }
      await this.tg.sendMessage(chatId, `📦 APK diterima: \`${path.basename(dest)}\`\nNak buat apa?`, {
        parseMode: "Markdown",
        replyMarkup: {
          inline_keyboard: [
            [
              { text: "🔍 Analisis", callback_data: "apk:analyze" },
              { text: "🔐 Audit", callback_data: "apk:audit" },
            ],
            [
              { text: "🧩 Decompile", callback_data: "apk:decompile" },
              { text: "✏️ Modifikasi", callback_data: "apk:modify" },
            ],
            [
              { text: "🛠 Fix/Patch", callback_data: "apk:fix" },
              { text: "🔨 Rebuild", callback_data: "apk:build" },
            ],
            [{ text: "📊 Diff (banding APK lain)", callback_data: "apk:diff" }],
          ],
        },
      });
      return;
    }

    // Images (screenshots) → let the AI actually read & diagnose them.
    if (IMAGE_EXT.has(ext)) {
      await this.handleImageUpload(chatId, userId, dest, ext, caption);
      return;
    }

    // If the user gave a caption with the file, act on it directly.
    if (caption && caption.trim()) {
      const note = `User memuat naik fail ke: ${dest}\nNota user: ${caption.trim()}`;
      await this.routeToAgent(chatId, userId, note, { replyTo: msg.message_id });
      return;
    }

    // Other files → ask what to do (so it's not rigid) instead of guessing.
    this.pendingFile.set(userId, dest);
    await this.tg.sendMessage(chatId, `📄 Fail diterima: \`${path.basename(dest)}\`\nNak buat apa?`, {
      parseMode: "Markdown",
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "📄 Analisis isi", callback_data: "file:analyze" },
            { text: "🔍 Cari isu/error", callback_data: "file:scan" },
          ],
          [{ text: "📝 Ringkaskan", callback_data: "file:summary" }],
        ],
      },
    });
  }

  // Handle an uploaded image. Two complementary paths so the AI can ALWAYS
  // "read" the picture and solve the problem in it:
  //   1. Vision model → send the image itself (plus OCR'd text as a hint).
  //   2. Non-vision model (or vision disabled) → OCR the image to text and feed
  //      that to the model, so even text-only models can diagnose a screenshot.
  async handleImageUpload(chatId, userId, dest, ext, caption) {
    const meta = this.store.getMeta(userId);
    const model = meta?.model || this.cfg.defaultModel;
    const useVision =
      this.cfg.enableVision && isVisionModel(model, this.models);

    // Best-effort OCR — gives exact error text (and is the only signal for
    // non-vision models). Never fatal if tesseract is missing.
    let ocrText = "";
    try {
      const r = await ocrImage(dest);
      if (r.ok && r.text) ocrText = r.text.slice(0, 6000);
    } catch {
      /* ignore OCR failures */
    }

    const userNote = caption ? `\nNota pengguna: ${caption}` : "";
    const ocrBlock = ocrText
      ? `\n\nTeks yang dikesan dari gambar (OCR):\n"""\n${ocrText}\n"""`
      : "";

    if (useVision) {
      const b64 = fs.readFileSync(dest).toString("base64");
      const mime =
        ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      const content = [
        { type: "text", text: `${IMAGE_ANALYSIS_PROMPT}${userNote}${ocrBlock}\n\nGambar disimpan di: ${dest}` },
        { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
      ];
      await this.routeToAgent(chatId, userId, content);
      return;
    }

    // Text-only model: rely on OCR. If OCR found nothing, tell the agent it can
    // run the ocr_image tool itself (and that the model may not support vision).
    const text = ocrText
      ? `${IMAGE_ANALYSIS_PROMPT}${userNote}${ocrBlock}\n\nGambar disimpan di: ${dest}`
      : `Pengguna menghantar gambar/screenshot di: ${dest}.${userNote}\n` +
        `Model semasa mungkin tiada sokongan penglihatan (vision). Guna tool \`ocr_image\` untuk membaca teks ` +
        `dalam gambar, kemudian ${IMAGE_ANALYSIS_PROMPT}`;
    await this.routeToAgent(chatId, userId, text);
  }

  // -------------------------------------------------------- agent route
  async routeToAgent(chatId, userId, userContent, { replyTo } = {}) {
    if (this.busy.has(userId)) {
      await this.tg.sendMessage(chatId, "⏳ Masih memproses permintaan sebelumnya, sila tunggu sekejap…");
      return;
    }
    this.busy.add(userId);

    const meta = this.store.ensureUser(userId, { defaultModel: this.cfg.defaultModel });
    const session = this.store.loadSession(userId, this.cfg.defaultModel);
    session.model = meta.model || this.cfg.defaultModel;
    const workspace = this.store.workspace(userId);

    const status = new StatusCard(this.tg, chatId);
    const plan = new PlanCard(this.tg, chatId);

    const ctx = {
      workspace,
      debug: this.cfg.debug,
      keystore: this.cfg.keystore,
      keystorePass: this.cfg.keystorePass,
      keystoreAlias: this.cfg.keystoreAlias,
      deliverables: [],
      deliverCaptions: {},
      // Long-term memory accessors for the remember/forget/list_memory tools.
      memory: {
        add: (text) => this.store.addMemory(userId, text),
        remove: (q) => this.store.removeMemory(userId, q),
        list: () => this.store.loadMemory(userId),
      },
      // Long-running tools (APK/project builds) report live % here so the chat
      // status card shows a progress bar instead of a bare spinner.
      onProgress: (p) => status.setProgress(p || {}),
      // The update_plan tool reports the visible step-by-step checklist here.
      onPlan: (steps, note) => {
        plan.update(steps, note);
      },
    };

    await status.begin("🧠 Berfikir…");
    const typing = new TypingPinger(this.tg, chatId);
    typing.start();

    let finalText = "";
    let hadError = null;
    // runTurn does not throw on API/model failures (e.g. a model returning 403
    // "not available", or a timeout) — it emits an "error" event and returns an
    // empty string. Capture that here so we can surface it instead of silently
    // replying "Selesai." (which made the bot look broken).
    let agentError = null;
    try {
      finalText = await runTurn({
        client: this.client,
        registry: this.registry,
        ctx,
        cfg: this.cfg,
        session,
        systemPrompt: renderSystemPrompt(workspace, this.store.memoryText(userId)),
        userContent,
        onEvent: (kind, payload) => {
          if (kind === "tool_start") status.setPhase(`⚙️ ${phaseLabel(payload.name)}…`);
          else if (kind === "thinking") status.setPhase("🧠 Berfikir…");
          else if (kind === "error") agentError = payload.error || agentError;
        },
      });
    } catch (e) {
      hadError = e;
    } finally {
      typing.stop();
      await status.finish();
      this.store.saveSession(userId, session);
      this.busy.delete(userId);
    }

    if (hadError) {
      await this.tg.sendMessage(chatId, `❌ Ralat: ${hadError.message || hadError}`);
      return;
    }

    const text = (finalText || "").trim();
    if (text) {
      await this.tg.sendMessage(chatId, text, { replyTo });
    }
    // Send any deliverables (final APKs etc.).
    for (const file of ctx.deliverables) {
      await this.deliverFile(chatId, userId, file, ctx.deliverCaptions[file]);
    }
    if (!text && !ctx.deliverables.length) {
      if (agentError) {
        // A model/API failure (unavailable model, timeout, rate limit, etc.).
        // Tell the user plainly and point them to /model instead of "Selesai.".
        await this.tg.sendMessage(
          chatId,
          `⚠️ Model gagal menjawab:\n\`${String(agentError).slice(0, 300)}\`\n\n` +
            `Model ini mungkin tak tersedia atau terlalu sibuk. Cuba hantar semula, ` +
            `atau tukar model dengan /model.`,
        );
      } else {
        await this.tg.sendMessage(
          chatId,
          "🤔 Model tak memberi sebarang jawapan. Cuba hantar semula atau tukar model dengan /model.",
        );
      }
    }
  }

  // Deliver one finished file: small files go straight into the chat; large
  // files (often hundreds of MB on a server) are offered via download link +
  // SFTP, since Telegram bot uploads are size-limited.
  async deliverFile(chatId, userId, file, caption) {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      await this.tg.sendMessage(chatId, `⚠️ Fail hasil tidak dijumpai: ${path.basename(file)}`);
      return;
    }
    // Keep a copy of finished APKs in the user's apk/ folder.
    try {
      if (file.toLowerCase().endsWith(".apk")) {
        const keep = path.join(this.store.apkDir(userId), path.basename(file));
        if (path.resolve(keep) !== path.resolve(file)) fs.copyFileSync(file, keep);
      }
    } catch {
      /* non-fatal */
    }

    if (size <= this.cfg.tgSendLimitBytes) {
      try {
        await this.tg.sendChatAction(chatId, "upload_document");
        await this.tg.sendDocument(chatId, file, { caption: caption || path.basename(file) });
        return;
      } catch (e) {
        // Fall through to link delivery on failure.
        log(`sendDocument failed (${path.basename(file)}): ${e.message}`);
      }
    }

    const link = this.downloadLink(userId);
    const human = humanSize(size);
    const lines = [
      `📦 *${escapeMd(path.basename(file))}* (${human}) sudah siap.`,
      size > this.cfg.tgSendLimitBytes
        ? `Fail melebihi had kirim Telegram (${Math.round(this.cfg.tgSendLimitBytes / 1024 / 1024)} MB), jadi guna pautan/SFTP:`
        : "Muat turun:",
    ];
    if (link) lines.push(`🔗 ${link}`);
    lines.push(`📁 SFTP: \`${file}\``);
    await this.tg.sendMessage(chatId, lines.join("\n"), { parseMode: "Markdown" });
  }

  // --------------------------------------------------------------- UI text
  async sendWelcome(chatId, userId) {
    const meta = this.store.getMeta(userId);
    const model = meta?.model || this.cfg.defaultModel;
    const status = this.userStatus(userId, meta);
    if (status !== "approved") {
      const note =
        status === "banned"
          ? "⛔ Akses anda telah disekat oleh admin."
          : `⏳ *Akses anda menunggu kelulusan admin.*\nID Telegram anda: \`${userId}\`\nAnda akan dimaklumkan sebaik diluluskan.`;
      await this.tg.sendMessage(chatId, note, { parseMode: "Markdown" });
      return;
    }
    const banner =
      "```\n" +
      "┌──(suzu㉿kali)-[~]\n" +
      "└─$ suzu --telegram\n" +
      "\n" +
      "   ███████╗██╗   ██╗███████╗██╗   ██╗\n" +
      "   ██╔════╝██║   ██║╚══███╔╝██║   ██║\n" +
      "   ███████╗██║   ██║  ███╔╝ ██║   ██║\n" +
      "   ╚════██║██║   ██║ ███╔╝  ██║   ██║\n" +
      "   ███████║╚██████╔╝███████╗╚██████╔╝\n" +
      "   ╚══════╝ ╚═════╝ ╚══════╝ ╚═════╝ \n" +
      "   APK Reverse-Engineering AI • online\n" +
      "```";
    const body =
      `*Selamat datang ke Suzu AI* 🐉\n\n` +
      `Saya pakar *reverse-engineering APK* — decompile, recompile, build, modify, sign & analisis APK semua framework (Java/Kotlin/Flutter/React Native/Unity/Xamarin/Native).\n\n` +
      `• Hantar APK → pilih tindakan (Analisis/Decompile/Build/Modifikasi)\n` +
      `• Atau taip apa saja, saya ada *memori chat* dan *tanpa had*.\n\n` +
      `Model semasa: \`${model}\``;
    await this.tg.sendMessage(chatId, banner + "\n" + body, {
      parseMode: "Markdown",
      replyMarkup: this.menuKeyboard(this.isAdmin(userId)),
    });
  }

  menuKeyboard(isAdmin = false) {
    const rows = [
      [
        { text: "🤖 Pilih Model", callback_data: "menu:models" },
        { text: "📊 Status", callback_data: "menu:status" },
      ],
      [
        { text: "📥 Download Fail", callback_data: "menu:download" },
        { text: "🧹 Reset Memori", callback_data: "menu:reset" },
      ],
      [{ text: "❓ Bantuan", callback_data: "menu:help" }],
    ];
    if (isAdmin) rows.push([{ text: "🛡️ Panel Admin", callback_data: "menu:admin" }]);
    return { inline_keyboard: rows };
  }

  async sendMenu(chatId, userId) {
    await this.tg.sendMessage(chatId, "📋 Menu utama:", {
      replyMarkup: this.menuKeyboard(this.isAdmin(userId)),
    });
  }

  async sendModelPicker(chatId, userId) {
    if (!this.models.length) this.models = await fetchModels(this.cfg);
    const meta = this.store.getMeta(userId);
    const current = meta?.model || this.cfg.defaultModel;
    const rows = [];
    for (let i = 0; i < this.models.length; i += 2) {
      const row = this.models.slice(i, i + 2).map((m) => ({
        text: (m.id === current ? "✅ " : "") + m.label + (m.vision ? " 👁" : ""),
        callback_data: `model:${m.id}`.slice(0, 64),
      }));
      rows.push(row);
    }
    await this.tg.sendMessage(chatId, `🤖 Pilih model AI (semasa: \`${current}\`):`, {
      parseMode: "Markdown",
      replyMarkup: { inline_keyboard: rows },
    });
  }

  helpText(userId) {
    const lines = [
      "*Suzu AI — Bantuan*",
      "",
      "Hantar mesej biasa untuk berbual / beri tugasan.",
      "Hantar fail/APK untuk dianalisis atau diproses.",
      "",
      "*Perintah:*",
      "`/start` — banner + menu",
      "`/model` — pilih model (atau `/model <nama>`)",
      "`/status` — lihat model & API semasa",
      "`/files` — senarai fail (chat/apk/files)",
      "`/download` — pautan muat turun semua fail anda",
      "`/sftp` — maklumat akses SFTP",
      "`/id` — papar ID Telegram anda",
      "`/reset` — kosongkan memori chat",
      "`/new` — mula sesi baharu",
      "`/memory` — lihat memori jangka panjang (keutamaan tersimpan)",
      "`/help` — bantuan ini",
    ];
    if (userId && this.isAdmin(userId)) {
      lines.push(
        "",
        "*Admin:* 🛡️",
        "`/admin` — panel admin",
        "`/users` — senarai semua pengguna",
        "`/pending` — permintaan menunggu kelulusan",
        "`/approve <id>` · `/ban <id>` · `/unban <id>`",
        "`/chat <id> [n]` — lihat perbualan pengguna",
        "`/userfiles <id>` — fail + pautan muat turun pengguna",
        "`/setapi <url> [key]` — tukar API",
      );
    }
    lines.push("", "_Memori chat aktif & tiada had permintaan._");
    return lines.join("\n");
  }

  filesText(userId) {
    const root = this.store.userDir(userId);
    const section = (label, dir) => {
      let items = [];
      try {
        items = fs.readdirSync(dir).filter((f) => !f.startsWith(".")).slice(0, 30);
      } catch {
        /* ignore */
      }
      return `*${label}* (${items.length})\n` + (items.map((f) => `• ${f}`).join("\n") || "_(kosong)_");
    };
    return [
      `📂 *Database anda*\n\`${root}\``,
      section("apk/", this.store.apkDir(userId)),
      section("files/", this.store.filesDir(userId)),
      "",
      "Guna `/download` untuk pautan muat turun.",
    ].join("\n\n");
  }

  async sendDownloadInfo(chatId, userId) {
    if (!this.fileServer) {
      await this.tg.sendMessage(
        chatId,
        "ℹ️ Server muat turun HTTP dimatikan (`SUZU_HTTP_ENABLE=0`). Guna `/sftp` untuk akses fail.",
        { parseMode: "Markdown" },
      );
      return;
    }
    const link = this.downloadLink(userId);
    await this.tg.sendMessage(
      chatId,
      [
        "📥 *Muat turun fail anda*",
        "Pautan ini menyenaraikan semua fail (chat/apk/files) dengan token peribadi:",
        link ? `🔗 ${link}` : "_(token tidak dijumpai)_",
        "",
        "Jika di server dengan domain, set `SUZU_PUBLIC_URL` supaya pautan boleh diakses dari mana-mana.",
        "Fail besar (ratusan MB) sila guna pautan ini atau SFTP (`/sftp`).",
      ].join("\n"),
      { parseMode: "Markdown" },
    );
  }

  sftpText(userId) {
    const root = this.store.userDir(userId);
    const user = process.env.USER || process.env.LOGNAME || "user";
    return [
      "📁 *Akses SFTP*",
      "Semua fail anda tersimpan di cakera, boleh diakses melalui SFTP/SSH:",
      "",
      `*Folder:* \`${root}\``,
      `*Contoh:* \`sftp ${user}@<host>\` kemudian \`cd ${root}\``,
      "",
      "Di *Termux*: `pkg install openssh && sshd` (port lalai 8022).",
      "Di *server*: pastikan `openssh-server` berjalan.",
      "Folder: `chat/` (memori), `apk/` (semua APK), `files/` (fail lain).",
    ].join("\n");
  }

  async statusText(userId) {
    const meta = this.store.getMeta(userId);
    const session = this.store.loadSession(userId, this.cfg.defaultModel);
    return [
      "*Status*",
      `Model: \`${meta?.model || this.cfg.defaultModel}\``,
      `API: \`${this.cfg.apiBaseUrl}\``,
      `Mesej dalam memori: *${session.messages.length}*`,
      `Workspace: \`${this.store.filesDir(userId)}\``,
      `Model tersedia: *${this.models.length}*`,
    ].join("\n");
  }

  // ----------------------------------------------------------- admin panel
  async sendAdminPanel(chatId) {
    const ids = this.store.listUsers();
    let pending = 0;
    let banned = 0;
    for (const id of ids) {
      const s = this.store.getMeta(id)?.status;
      if (s === "pending") pending += 1;
      else if (s === "banned") banned += 1;
    }
    const text = [
      "🛡️ *Panel Admin Suzu*",
      "",
      `Jumlah pengguna: *${ids.length}*`,
      `Menunggu kelulusan: *${pending}*`,
      `Disekat: *${banned}*`,
      `Mod kelulusan: ${this.cfg.requireApproval ? "*ON* (user baru perlu approve)" : "*OFF* (terbuka)"}`,
      "",
      "Arahan: `/approve <id>`, `/ban <id>`, `/unban <id>`, `/chat <id>`, `/userfiles <id>`",
    ].join("\n");
    await this.tg.sendMessage(chatId, text, {
      parseMode: "Markdown",
      replyMarkup: {
        inline_keyboard: [
          [
            { text: `⏳ Pending (${pending})`, callback_data: "adm:pending:" },
            { text: "👥 Semua User", callback_data: "adm:users:" },
          ],
        ],
      },
    });
  }

  async sendUsersList(chatId) {
    const ids = this.store.listUsers();
    if (!ids.length) {
      await this.tg.sendMessage(chatId, "Belum ada pengguna.");
      return;
    }
    const rows = ids
      .map((id) => this.store.userSummary(id))
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const lines = ["👥 *Senarai pengguna*", ""];
    for (const u of rows.slice(0, 50)) {
      const name = u.username ? `@${escapeMd(u.username)}` : escapeMd(u.first_name || "-");
      lines.push(
        `${statusBadge(this.userStatus(u.id, u))} \`${u.id}\` ${name}\n` +
          `   💬 ${u.messages} • 📦 ${u.apkCount} apk • 📄 ${u.fileCount} fail • ${humanSize(u.sizeBytes)}`,
      );
    }
    if (rows.length > 50) lines.push(`… dan ${rows.length - 50} lagi`);
    lines.push("", "Tekan/taip `/chat <id>` untuk lihat perbualan.");
    await this.tg.sendMessage(chatId, lines.join("\n"), { parseMode: "Markdown" });
  }

  async sendPendingList(chatId) {
    const ids = this.store.listUsers().filter((id) => this.store.getMeta(id)?.status === "pending");
    if (!ids.length) {
      await this.tg.sendMessage(chatId, "✅ Tiada permintaan menunggu kelulusan.");
      return;
    }
    for (const id of ids.slice(0, 20)) {
      const u = this.store.userSummary(id);
      const name = u.username ? `@${escapeMd(u.username)}` : escapeMd(u.first_name || "-");
      await this.tg.sendMessage(chatId, `⏳ \`${u.id}\` ${name}`, {
        parseMode: "Markdown",
        replyMarkup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `adm:approve:${u.id}` },
              { text: "⛔ Ban", callback_data: `adm:ban:${u.id}` },
            ],
          ],
        },
      });
    }
  }

  async sendUserChat(chatId, targetId, n) {
    if (!this.store.getMeta(targetId)) {
      await this.tg.sendMessage(chatId, `Pengguna \`${targetId}\` tidak dijumpai.`, { parseMode: "Markdown" });
      return;
    }
    const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 60) : 20;
    const msgs = this.store.recentMessages(targetId, limit);
    const u = this.store.userSummary(targetId);
    const name = u.username ? `@${u.username}` : u.first_name || "-";
    if (!msgs.length) {
      await this.tg.sendMessage(chatId, `💬 \`${targetId}\` (${name}) belum ada perbualan.`, { parseMode: "Markdown" });
      return;
    }
    const header = `💬 *Perbualan ${escapeMd(name)}* \`${targetId}\` (${msgs.length} mesej terakhir)\n`;
    const body = msgs
      .map((m) => {
        const who = m.role === "user" ? "👤" : "🤖";
        let t = m.text.replace(/\s+/g, " ").trim();
        if (t.length > 400) t = t.slice(0, 400) + "…";
        return `${who} ${t}`;
      })
      .join("\n\n");
    // Reuse the chat splitter in TelegramAPI.sendMessage (it chunks long text).
    await this.tg.sendMessage(chatId, header + "\n" + body);
  }

  async sendUserFiles(chatId, targetId) {
    if (!this.store.getMeta(targetId)) {
      await this.tg.sendMessage(chatId, `Pengguna \`${targetId}\` tidak dijumpai.`, { parseMode: "Markdown" });
      return;
    }
    const section = (label, dir) => {
      let items = [];
      try {
        items = fs.readdirSync(dir).filter((f) => !f.startsWith(".")).slice(0, 30);
      } catch {
        /* ignore */
      }
      return `*${label}* (${items.length})\n` + (items.map((f) => `• ${escapeMd(f)}`).join("\n") || "_(kosong)_");
    };
    const link = this.downloadLink(targetId);
    const lines = [
      `📂 *Fail pengguna* \`${targetId}\``,
      section("apk/", this.store.apkDir(targetId)),
      section("files/", this.store.filesDir(targetId)),
    ];
    if (link) lines.push("", `🔗 Muat turun: ${link}`);
    lines.push(`📁 SFTP: \`${this.store.userDir(targetId)}\``);
    await this.tg.sendMessage(chatId, lines.join("\n\n"), { parseMode: "Markdown" });
  }
}

// Animated status "card": one message we keep editing with a spinner + phase.
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const BAR_WIDTH = 12;

// Render a textual progress bar like `▰▰▰▰▱▱▱▱▱▱▱▱ 33%`.
function progressBar(percent) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((p / 100) * BAR_WIDTH);
  return "▰".repeat(filled) + "▱".repeat(BAR_WIDTH - filled) + ` ${p}%`;
}

class StatusCard {
  constructor(tg, chatId) {
    this.tg = tg;
    this.chatId = chatId;
    this.messageId = null;
    this.phase = "🧠 Berfikir…";
    this.frame = 0;
    this.timer = null;
    this.lastEdit = 0;
    // Progress state. When percent is null we show the spinner; otherwise we
    // show a % bar. `creepTo` lets the bar drift forward between real updates
    // so long stages still feel alive.
    this.percent = null;
    this.creepTo = null;
  }
  async begin(initial) {
    this.phase = initial;
    try {
      const m = await this.tg.sendMessage(this.chatId, `${SPIN[0]} ${this.phase}`);
      this.messageId = m?.message_id || null;
    } catch {
      /* ignore */
    }
    this.timer = setInterval(() => this.tick(), 1300);
  }
  // Spinner mode (no known %). Used for thinking / generic tools.
  setPhase(text) {
    this.phase = text;
    this.percent = null;
    this.creepTo = null;
  }
  // Progress mode. percent = current known %, label = phase text, ceil = a soft
  // ceiling the bar may slowly creep toward until the next real update.
  setProgress({ percent, label, ceil } = {}) {
    if (typeof label === "string" && label) this.phase = label;
    if (Number.isFinite(percent)) {
      this.percent = this.percent == null ? percent : Math.max(this.percent, percent);
    } else if (this.percent == null) {
      this.percent = 0;
    }
    this.creepTo = Number.isFinite(ceil) ? Math.max(ceil, this.percent) : null;
  }
  render() {
    if (this.percent == null) return `${SPIN[this.frame]} ${this.phase}`;
    return `${SPIN[this.frame]} ${this.phase}\n${progressBar(this.percent)}`;
  }
  async tick() {
    if (!this.messageId) return;
    this.frame = (this.frame + 1) % SPIN.length;
    // Ease the displayed % toward the soft ceiling between real updates.
    if (this.percent != null && this.creepTo != null && this.percent < this.creepTo) {
      const step = Math.max(1, (this.creepTo - this.percent) * 0.18);
      this.percent = Math.min(this.creepTo, this.percent + step);
    }
    await this.tg.editMessageText(this.chatId, this.messageId, this.render());
  }
  async finish() {
    if (this.timer) clearInterval(this.timer);
    if (this.messageId) {
      try {
        await this.tg.call("deleteMessage", { chat_id: this.chatId, message_id: this.messageId });
      } catch {
        await this.tg.editMessageText(this.chatId, this.messageId, "✅ Siap");
      }
    }
  }
}

// A separate chat message that shows the AI's step-by-step plan (a visible
// checklist), updated as the model calls the update_plan tool. Lets the user
// follow along like Devin's task list.
const PLAN_ICON = { pending: "⬜️", in_progress: "🔄", done: "✅" };

class PlanCard {
  constructor(tg, chatId) {
    this.tg = tg;
    this.chatId = chatId;
    this.messageId = null;
    this.lastText = "";
  }
  render(steps, note) {
    const lines = steps.map((s) => `${PLAN_ICON[s.status] || "⬜️"} ${s.title}`);
    const done = steps.filter((s) => s.status === "done").length;
    let out = `📋 Pelan (${done}/${steps.length})\n` + lines.join("\n");
    if (note) out += `\n\n${note}`;
    return out;
  }
  async update(steps, note) {
    if (!Array.isArray(steps) || !steps.length) return;
    const text = this.render(steps, note);
    if (text === this.lastText) return;
    this.lastText = text;
    try {
      if (!this.messageId) {
        const m = await this.tg.sendMessage(this.chatId, text);
        this.messageId = m?.message_id || null;
      } else {
        await this.tg.editMessageText(this.chatId, this.messageId, text);
      }
    } catch {
      /* plan rendering must never break the run */
    }
  }
}

class TypingPinger {
  constructor(tg, chatId) {
    this.tg = tg;
    this.chatId = chatId;
    this.timer = null;
  }
  start() {
    this.tg.sendChatAction(this.chatId, "typing");
    this.timer = setInterval(() => this.tg.sendChatAction(this.chatId, "typing"), 4000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

function safeName(name) {
  return String(name).replace(/[^\w.\-]+/g, "_").slice(0, 120) || `file_${Date.now()}`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}
function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function escapeMd(s) {
  return String(s).replace(/([_*`\[\]])/g, "\\$1");
}
function statusBadge(status) {
  if (status === "approved") return "✅ approved";
  if (status === "pending") return "⏳ pending";
  if (status === "banned") return "⛔ banned";
  return "• " + (status || "—");
}
