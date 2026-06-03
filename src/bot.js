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
import os from "node:os";

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
    this.store.ensureUser(userId, {
      username: from.username,
      firstName: from.first_name,
      defaultModel: this.cfg.defaultModel,
    });

    const text = (msg.text || msg.caption || "").trim();

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
        await this.tg.sendMessage(chatId, this.helpText(), { parseMode: "Markdown" });
        return true;
      }
      case "/menu": {
        await this.sendMenu(chatId);
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
      default:
        return false; // unknown slash → let it reach the agent as text
    }
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

    if (data === "menu:models") {
      await this.tg.answerCallbackQuery(cq.id);
      await this.sendModelPicker(chatId, userId);
      return;
    }
    if (data === "menu:help") {
      await this.tg.answerCallbackQuery(cq.id);
      await this.tg.sendMessage(chatId, this.helpText(), { parseMode: "Markdown" });
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
      this.pendingApk.delete(userId);
      const map = {
        analyze: `Analisis penuh APK ini (framework, package, permission, library): ${file}`,
        decompile: `Decompile APK ini dengan apktool dan ringkaskan strukturnya: ${file}`,
        build: `Recompile/rebuild APK dari sumber ini dan hasilkan APK yang ditandatangani: ${file}`,
        modify: `Saya mahu ubah suai APK ini. Decompile dulu, kemudian tanya saya bahagian apa yang nak diubah: ${file}`,
      };
      await this.routeToAgent(chatId, userId, map[action] || `Proses APK: ${file}`);
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
      this.pendingApk.set(userId, dest);
      await this.tg.sendMessage(chatId, `📦 APK diterima: \`${path.basename(dest)}\`\nPilih tindakan:`, {
        parseMode: "Markdown",
        replyMarkup: {
          inline_keyboard: [
            [
              { text: "🔍 Analisis", callback_data: "apk:analyze" },
              { text: "🧩 Decompile", callback_data: "apk:decompile" },
            ],
            [
              { text: "🔨 Build/Recompile", callback_data: "apk:build" },
              { text: "✏️ Modifikasi", callback_data: "apk:modify" },
            ],
          ],
        },
      });
      return;
    }

    // Image + vision model → forward as image content.
    const meta = this.store.getMeta(userId);
    const model = meta?.model || this.cfg.defaultModel;
    if (this.cfg.enableVision && IMAGE_EXT.has(ext) && isVisionModel(model, this.models)) {
      const b64 = fs.readFileSync(dest).toString("base64");
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
      const content = [
        { type: "text", text: caption || "Tolong lihat gambar ini." },
        { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
      ];
      await this.routeToAgent(chatId, userId, content, { fileNote: `Gambar disimpan di ${dest}` });
      return;
    }

    // Other files → announce path so the agent can read/analyse.
    const note = `User memuat naik fail ke: ${dest}` + (caption ? `\nNota user: ${caption}` : "");
    await this.routeToAgent(chatId, userId, note, { replyTo: msg.message_id });
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

    const ctx = {
      workspace,
      debug: this.cfg.debug,
      keystore: this.cfg.keystore,
      keystorePass: this.cfg.keystorePass,
      keystoreAlias: this.cfg.keystoreAlias,
      deliverables: [],
      deliverCaptions: {},
    };

    const status = new StatusCard(this.tg, chatId);
    await status.begin("🧠 Berfikir…");
    const typing = new TypingPinger(this.tg, chatId);
    typing.start();

    let finalText = "";
    let hadError = null;
    try {
      finalText = await runTurn({
        client: this.client,
        registry: this.registry,
        ctx,
        cfg: this.cfg,
        session,
        systemPrompt: renderSystemPrompt(workspace),
        userContent,
        onEvent: (kind, payload) => {
          if (kind === "tool_start") status.setPhase(`⚙️ ${phaseLabel(payload.name)}…`);
          else if (kind === "thinking") status.setPhase("🧠 Berfikir…");
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
      await this.tg.sendMessage(chatId, "✅ Selesai.");
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
      replyMarkup: this.menuKeyboard(),
    });
  }

  menuKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: "🤖 Pilih Model", callback_data: "menu:models" },
          { text: "📊 Status", callback_data: "menu:status" },
        ],
        [
          { text: "📥 Download Fail", callback_data: "menu:download" },
          { text: "🧹 Reset Memori", callback_data: "menu:reset" },
        ],
        [{ text: "❓ Bantuan", callback_data: "menu:help" }],
      ],
    };
  }

  async sendMenu(chatId) {
    await this.tg.sendMessage(chatId, "📋 Menu utama:", { replyMarkup: this.menuKeyboard() });
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

  helpText() {
    return [
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
      "`/reset` — kosongkan memori chat",
      "`/new` — mula sesi baharu",
      "`/setapi <url> [key]` — tukar API (admin)",
      "`/help` — bantuan ini",
      "",
      "_Memori chat aktif & tiada had permintaan._",
    ].join("\n");
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
}

// Animated status "card": one message we keep editing with a spinner + phase.
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
class StatusCard {
  constructor(tg, chatId) {
    this.tg = tg;
    this.chatId = chatId;
    this.messageId = null;
    this.phase = "🧠 Berfikir…";
    this.frame = 0;
    this.timer = null;
    this.lastEdit = 0;
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
  setPhase(text) {
    this.phase = text;
  }
  async tick() {
    if (!this.messageId) return;
    this.frame = (this.frame + 1) % SPIN.length;
    await this.tg.editMessageText(this.chatId, this.messageId, `${SPIN[this.frame]} ${this.phase}`);
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
