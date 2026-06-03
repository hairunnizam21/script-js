// Tiny Telegram Bot API client (stdlib only: global fetch + node:fs).
// Implements just the methods the bot needs: long-polling getUpdates, message
// send/edit, chat actions, file download, and document upload (multipart built
// by hand so we need no form-data dependency).

import fs from "node:fs";
import path from "node:path";

export const MAX_MSG_CHARS = 3900; // Telegram caps bodies at 4096; leave margin.

export class TelegramError extends Error {}

export class TelegramAPI {
  constructor(token, { timeout = 35000 } = {}) {
    this.token = token;
    this.timeout = timeout;
    this.base = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
  }

  async call(method, params = {}, { timeout } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout ?? this.timeout);
    try {
      const resp = await fetch(`${this.base}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({}));
      if (!data.ok) {
        throw new TelegramError(
          `${method} failed: ${data.description || resp.status}`,
        );
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async getMe() {
    return this.call("getMe", {}, { timeout: 15000 });
  }

  async getUpdates(offset, timeoutSec = 30) {
    return this.call(
      "getUpdates",
      {
        offset,
        timeout: timeoutSec,
        allowed_updates: ["message", "callback_query"],
      },
      { timeout: (timeoutSec + 10) * 1000 },
    );
  }

  async sendChatAction(chatId, action = "typing") {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action });
    } catch {
      /* non-fatal */
    }
  }

  // Send text, splitting into <= MAX_MSG_CHARS chunks. Returns the last
  // message object (useful for editing a status card).
  async sendMessage(chatId, text, { parseMode, replyTo, replyMarkup } = {}) {
    const chunks = splitText(String(text ?? ""), MAX_MSG_CHARS);
    let last = null;
    for (let i = 0; i < chunks.length; i++) {
      const params = { chat_id: chatId, text: chunks[i] };
      if (parseMode) params.parse_mode = parseMode;
      if (replyTo && i === 0) params.reply_to_message_id = replyTo;
      if (replyMarkup && i === chunks.length - 1) params.reply_markup = replyMarkup;
      try {
        last = await this.call("sendMessage", params);
      } catch (e) {
        // Retry once without parse_mode (markdown entities can be invalid).
        if (parseMode) {
          delete params.parse_mode;
          last = await this.call("sendMessage", params);
        } else {
          throw e;
        }
      }
    }
    return last;
  }

  async editMessageText(chatId, messageId, text, { parseMode } = {}) {
    if (!messageId) return null;
    const params = {
      chat_id: chatId,
      message_id: messageId,
      text: String(text).slice(0, MAX_MSG_CHARS),
    };
    if (parseMode) params.parse_mode = parseMode;
    try {
      return await this.call("editMessageText", params);
    } catch {
      return null; // "message is not modified" etc. — ignore.
    }
  }

  async answerCallbackQuery(id, text = "") {
    try {
      await this.call("answerCallbackQuery", { callback_query_id: id, text });
    } catch {
      /* ignore */
    }
  }

  // Resolve a file_id to a download path, then stream it to disk.
  async downloadFile(fileId, destPath) {
    const info = await this.call("getFile", { file_id: fileId });
    const remote = info.file_path;
    if (!remote) throw new TelegramError("getFile returned no file_path");
    const url = `${this.fileBase}/${remote}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new TelegramError(`download failed: HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buf);
    return { path: destPath, size: buf.length, remote };
  }

  // Upload a local file as a document (multipart/form-data built by hand).
  async sendDocument(chatId, filePath, { caption } = {}) {
    const data = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const boundary = `----suzu${Date.now().toString(16)}${Math.random()
      .toString(16)
      .slice(2)}`;
    const parts = [];
    const pushField = (name, value) => {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    };
    pushField("chat_id", String(chatId));
    if (caption) pushField("caption", caption.slice(0, 1000));
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    parts.push(data);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000);
    try {
      const resp = await fetch(`${this.base}/sendDocument`, {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.length),
        },
        body,
        signal: controller.signal,
      });
      const json = await resp.json().catch(() => ({}));
      if (!json.ok) {
        throw new TelegramError(`sendDocument failed: ${json.description || resp.status}`);
      }
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Split text on paragraph/line boundaries where possible.
export function splitText(text, limit) {
  if (text.length <= limit) return [text || ""];
  const out = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit; // no good newline — hard cut
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}
