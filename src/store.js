// Per-user persistent storage ("each Telegram user gets their own database").
//
// Layout (under DATA_DIR/users/<telegram_user_id>/):
//   meta.json        — username, first seen, current model, download token
//   chat/
//     session.json   — full chat memory (message history)
//   apk/             — every APK the user uploads + APKs the AI builds
//   files/           — every other file (txt, images, archives, …)
//
// `apk/` and `files/` are also the AI's workspace (the user dir root is the
// workspace, so the model can read/write both subfolders). Everything is plain
// files on disk, so it is downloadable over the built-in HTTP server and over
// SFTP. Keeping a folder per user means conversations never bleed into each
// other and the AI keeps long-term memory of each person's chat.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SESSION_VERSION = 1;

export class UserStore {
  constructor(usersDir) {
    this.usersDir = usersDir;
  }

  userDir(userId) {
    return path.join(this.usersDir, String(userId));
  }

  // The AI workspace is the user's root dir; it contains apk/ and files/.
  workspace(userId) {
    return this.userDir(userId);
  }
  chatDir(userId) {
    return path.join(this.userDir(userId), "chat");
  }
  apkDir(userId) {
    return path.join(this.userDir(userId), "apk");
  }
  filesDir(userId) {
    return path.join(this.userDir(userId), "files");
  }

  _metaPath(userId) {
    return path.join(this.userDir(userId), "meta.json");
  }
  _sessionPath(userId) {
    return path.join(this.chatDir(userId), "session.json");
  }

  ensureUser(userId, { username, firstName, defaultModel } = {}) {
    const dir = this.userDir(userId);
    for (const d of [this.chatDir(userId), this.apkDir(userId), this.filesDir(userId)]) {
      fs.mkdirSync(d, { recursive: true });
    }
    let meta = this.readJson(this._metaPath(userId), null);
    if (!meta) {
      meta = {
        id: String(userId),
        username: username || "",
        first_name: firstName || "",
        created_at: Date.now(),
        model: defaultModel || "",
        download_token: crypto.randomBytes(16).toString("hex"),
        api_base_url: "", // per-user override (optional)
        api_key: "",
      };
      this.writeJson(this._metaPath(userId), meta);
    } else {
      if (!meta.download_token) {
        meta.download_token = crypto.randomBytes(16).toString("hex");
        this.writeJson(this._metaPath(userId), meta);
      }
      // Keep username fresh.
      let changed = false;
      if (username && meta.username !== username) {
        meta.username = username;
        changed = true;
      }
      if (firstName && meta.first_name !== firstName) {
        meta.first_name = firstName;
        changed = true;
      }
      if (changed) this.writeJson(this._metaPath(userId), meta);
    }
    return meta;
  }

  getMeta(userId) {
    return this.readJson(this._metaPath(userId), null);
  }

  setMeta(userId, updates) {
    const meta = this.getMeta(userId) || { id: String(userId) };
    const merged = { ...meta, ...updates };
    this.writeJson(this._metaPath(userId), merged);
    return merged;
  }

  // Load (or lazily create) the chat-memory session for a user.
  loadSession(userId, defaultModel) {
    const p = this._sessionPath(userId);
    let data = this.readJson(p, null);
    if (!data) {
      data = {
        version: SESSION_VERSION,
        created_at: Date.now(),
        updated_at: Date.now(),
        messages: [],
      };
      this.writeJson(p, data);
    }
    return data;
  }

  saveSession(userId, session) {
    session.updated_at = Date.now();
    this.writeJson(this._sessionPath(userId), session);
  }

  // Clear chat memory but keep the user's files.
  resetSession(userId) {
    const data = {
      version: SESSION_VERSION,
      created_at: Date.now(),
      updated_at: Date.now(),
      messages: [],
    };
    this.writeJson(this._sessionPath(userId), data);
    return data;
  }

  listUsers() {
    try {
      return fs
        .readdirSync(this.usersDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  // --- low-level json helpers (atomic writes) ---
  readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  writeJson(file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  }
}

// Trim the transcript we *send* to the model so latency stays bounded as
// history grows. The full history is always kept on disk (memory). We keep the
// most recent messages within a character budget, never splitting a tool call
// from its result, and always keeping the system prompt (handled by caller).
export function pruneMessages(messages, { charBudget, toolResultCharCap }) {
  // Cap individual tool results first.
  const capped = messages.map((m) => {
    if (m.role === "tool" && typeof m.content === "string" && toolResultCharCap > 0) {
      if (m.content.length > toolResultCharCap) {
        return {
          ...m,
          content:
            m.content.slice(0, toolResultCharCap) +
            `\n…[trimmed ${m.content.length - toolResultCharCap} chars — save large output to a file]…`,
        };
      }
    }
    return m;
  });

  if (charBudget <= 0) return capped;

  // Walk from the end, accumulating until we hit the budget.
  let total = 0;
  let startIdx = capped.length;
  for (let i = capped.length - 1; i >= 0; i--) {
    const len = msgLen(capped[i]);
    if (total + len > charBudget && capped.length - i > 2) {
      break;
    }
    total += len;
    startIdx = i;
  }
  let kept = capped.slice(startIdx);

  // Don't start the window on an orphaned tool result (must follow its
  // assistant tool_calls message). Drop leading tool messages.
  while (kept.length && kept[0].role === "tool") {
    kept = kept.slice(1);
  }
  return kept;
}

function msgLen(m) {
  if (typeof m.content === "string") return m.content.length + 16;
  if (Array.isArray(m.content)) {
    return (
      m.content.reduce((n, part) => n + (part.text ? part.text.length : 256), 0) + 16
    );
  }
  if (m.tool_calls) {
    return (
      m.tool_calls.reduce(
        (n, c) => n + (c.function?.arguments?.length || 0) + (c.function?.name?.length || 0),
        0,
      ) + 16
    );
  }
  return 16;
}
