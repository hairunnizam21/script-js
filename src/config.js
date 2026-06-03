// Runtime configuration for Suzu-JS.
//
// Everything is driven by environment variables, loaded from a `.env` file so
// the same install works on Termux and on a server. The API is fully
// "universal/custom": base URL, key and model can be changed any time without
// reinstalling — either by editing `.env`, running `suzu config`, or via the
// Telegram `/setapi` and `/model` commands (which persist back to `.env`).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------

// All persistent state lives under one portable directory. Works the same on
// Termux ($HOME is inside the app sandbox) and on a server.
export const DATA_DIR =
  process.env.SUZU_DATA_DIR || path.join(os.homedir(), ".suzu-js");

export const ENV_FILE = process.env.SUZU_ENV_FILE || path.join(DATA_DIR, ".env");

export const USERS_DIR = path.join(DATA_DIR, "users");
export const LOG_DIR = path.join(DATA_DIR, "logs");
export const KEYSTORE_DIR = path.join(DATA_DIR, "keystores");
export const PID_FILE = path.join(DATA_DIR, "suzu-bot.pid");
export const LOG_FILE = path.join(LOG_DIR, "bot.log");

export function ensureDirs() {
  for (const d of [DATA_DIR, USERS_DIR, LOG_DIR, KEYSTORE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// --------------------------------------------------------------------------
// .env loading / saving
// --------------------------------------------------------------------------

// Parse a dotenv-style file into a plain object. Tolerant of comments, blank
// lines, `export ` prefixes and quoted values.
export function parseEnvFile(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const body = s.startsWith("export ") ? s.slice(7) : s;
    const eq = body.indexOf("=");
    if (eq < 0) continue;
    const k = body.slice(0, eq).trim();
    let v = body.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

// Load `.env` into process.env without clobbering vars already set in the
// real environment (real env wins — handy for systemd / CI overrides).
export function loadEnv(file = ENV_FILE) {
  const parsed = parseEnvFile(file);
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === "") {
      process.env[k] = v;
    }
  }
  return parsed;
}

// Persist a subset of keys back to `.env`, preserving any other existing keys.
// Used by `suzu config` and the Telegram `/setapi` / `/model` commands so the
// API config can be swapped at runtime and survive restarts.
export function saveEnv(updates, file = ENV_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = parseEnvFile(file);
  const merged = { ...current, ...updates };
  const lines = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`);
  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  // Reflect immediately in this process.
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined && v !== null) process.env[k] = String(v);
  }
  return merged;
}

// --------------------------------------------------------------------------
// Config object
// --------------------------------------------------------------------------

function envStr(name, def = "") {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : def;
}
function envNum(name, def) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : def;
}
function envBool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return !["0", "false", "no", "off"].includes(String(v).toLowerCase());
}

// Default API points at the user's current provider but is fully overridable.
const DEFAULT_BASE_URL = "https://api.cybersecdev.cloud/v1";
const DEFAULT_MODEL = "fiq/qwen3.6-plus";

export function loadConfig() {
  ensureDirs();
  loadEnv();

  return {
    // --- Universal / custom API (swappable at runtime) ---
    apiBaseUrl: envStr("AI_API_BASE_URL", DEFAULT_BASE_URL).replace(/\/+$/, ""),
    apiKey: envStr("AI_API_KEY", ""),
    defaultModel: envStr("AI_DEFAULT_MODEL", DEFAULT_MODEL),

    // --- Telegram ---
    telegramToken: envStr("TELEGRAM_BOT_TOKEN", ""),
    telegramBotUsername: envStr("TELEGRAM_BOT_USERNAME", ""),
    // Comma-separated numeric user ids allowed to use the bot. Empty = allow all.
    allowedUserIds: envStr("TELEGRAM_ALLOWED_USER_IDS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Admin user ids may run /setapi, approve/ban users, view chats, etc.
    // Empty = same as allowed list / all.
    adminUserIds: envStr("TELEGRAM_ADMIN_USER_IDS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // When on, new users start as "pending" and cannot use the AI until an
    // admin approves them (admins are notified with Approve/Ban buttons).
    requireApproval: envBool("SUZU_REQUIRE_APPROVAL", false),

    // --- Agent / behaviour ---
    requestTimeout: envNum("SUZU_REQUEST_TIMEOUT", 300) * 1000,
    maxToolIters: envNum("SUZU_MAX_TOOL_ITERS", 40),
    maxTokens: envNum("SUZU_MAX_TOKENS", 8192),
    contextCharBudget: envNum("SUZU_CONTEXT_CHAR_BUDGET", 48000),
    toolResultCharCap: envNum("SUZU_TOOL_RESULT_CHAR_CAP", 8000),
    enableVision: envBool("SUZU_ENABLE_VISION", true),
    debug: envBool("SUZU_DEBUG", false),

    // --- Built-in HTTP file server (download links) ---
    httpEnable: envBool("SUZU_HTTP_ENABLE", true),
    httpPort: envNum("SUZU_HTTP_PORT", 8088),
    // Public base URL if reachable from outside (e.g. https://re.example.com).
    // Empty = links use the server's host/IP or localhost.
    publicUrl: envStr("SUZU_PUBLIC_URL", ""),
    // Optional host/IP hint used to build links when publicUrl is empty.
    publicHost: envStr("SUZU_PUBLIC_HOST", ""),
    // Files <= this many MB are sent straight into the Telegram chat; larger
    // files (common on a server) are offered via download link + SFTP instead.
    tgSendLimitBytes: envNum("SUZU_TG_SEND_LIMIT_MB", 20) * 1024 * 1024,

    // --- Signing ---
    keystore: envStr("SUZU_KEYSTORE", path.join(KEYSTORE_DIR, "debug.keystore")),
    keystorePass: envStr("SUZU_KEYSTORE_PASS", "android"),
    keystoreAlias: envStr("SUZU_KEYSTORE_ALIAS", "androiddebugkey"),

    // --- Paths ---
    dataDir: DATA_DIR,
    usersDir: USERS_DIR,
    logDir: LOG_DIR,
    envFile: ENV_FILE,
  };
}

export const DEFAULTS = { DEFAULT_BASE_URL, DEFAULT_MODEL };
