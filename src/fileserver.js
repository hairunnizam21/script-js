// Built-in HTTP file server (stdlib http, no deps). Lets each Telegram user
// download everything in their folder (chat/, apk/, files/) from a phone or PC
// via a tokenised link. Path traversal is blocked; access requires the
// per-user token stored in meta.json.
//
// Routes:
//   GET /u/<userId>?t=<token>             → HTML listing of the user's files
//   GET /d/<userId>/<token>/<relpath...>  → download a single file
//   GET /health                           → "ok"

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";

const MIME = {
  ".apk": "application/vnd.android.package-archive",
  ".aab": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".jar": "application/java-archive",
  ".smali": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

export class FileServer {
  constructor(store, { port, publicUrl } = {}) {
    this.store = store;
    this.port = port || 8088;
    this.publicUrl = (publicUrl || "").replace(/\/+$/, "");
    this.server = null;
  }

  // Build the share link the bot sends to a user.
  linkFor(userId, token, host) {
    const base = this.publicUrl || (host ? `http://${host}` : `http://127.0.0.1:${this.port}`);
    return `${base}/u/${userId}?t=${token}`;
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on("error", (e) => {
      process.stdout.write(`[fileserver] error: ${e.message}\n`);
    });
    this.server.listen(this.port, () => {
      process.stdout.write(`[fileserver] listening on :${this.port}\n`);
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  handle(req, res) {
    let u;
    try {
      u = new URL(req.url, `http://localhost:${this.port}`);
    } catch {
      return send(res, 400, "bad request");
    }
    const parts = u.pathname.split("/").filter(Boolean);

    if (u.pathname === "/health") return send(res, 200, "ok");

    // Listing: /u/<userId>?t=<token>
    if (parts[0] === "u" && parts.length === 2) {
      const userId = decodeURIComponent(parts[1]);
      const token = u.searchParams.get("t") || "";
      if (!this.checkToken(userId, token)) return send(res, 403, "forbidden");
      return this.listing(res, userId, token);
    }

    // Download: /d/<userId>/<token>/<relpath...>
    if (parts[0] === "d" && parts.length >= 3) {
      const userId = decodeURIComponent(parts[1]);
      const token = decodeURIComponent(parts[2]);
      if (!this.checkToken(userId, token)) return send(res, 403, "forbidden");
      const rel = parts.slice(3).map(decodeURIComponent).join("/");
      return this.download(res, userId, rel);
    }

    return send(res, 404, "not found");
  }

  checkToken(userId, token) {
    const meta = this.store.getMeta(userId);
    return !!meta && !!token && token === meta.download_token;
  }

  // Safely resolve a relative path inside the user's dir.
  resolveInside(userId, rel) {
    const root = path.resolve(this.store.userDir(userId));
    const full = path.resolve(root, rel || ".");
    if (full !== root && !full.startsWith(root + path.sep)) return null;
    return full;
  }

  listing(res, userId, token) {
    const root = this.store.userDir(userId);
    const rows = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else {
          const rel = path.relative(root, full).split(path.sep).join("/");
          let size = 0;
          try {
            size = fs.statSync(full).size;
          } catch {
            /* ignore */
          }
          const href = `/d/${encodeURIComponent(userId)}/${encodeURIComponent(token)}/` +
            rel.split("/").map(encodeURIComponent).join("/");
          rows.push(
            `<tr><td><a href="${href}">${escapeHtml(rel)}</a></td><td style="text-align:right">${humanSize(size)}</td></tr>`,
          );
        }
      }
    };
    walk(root);
    const html =
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Suzu • Fail anda</title>` +
      `<style>body{background:#0b0f14;color:#cfe;font-family:ui-monospace,Menlo,Consolas,monospace;margin:0;padding:18px}` +
      `h1{color:#4fc3f7;font-size:18px}a{color:#80e27e;text-decoration:none}a:hover{text-decoration:underline}` +
      `table{width:100%;border-collapse:collapse;margin-top:10px}td{padding:6px 8px;border-bottom:1px solid #1d2a35}` +
      `.hdr{color:#90a4ae;font-size:12px}</style>` +
      `<h1>🐉 Suzu — fail untuk user ${escapeHtml(userId)}</h1>` +
      `<div class="hdr">chat/ • apk/ • files/ — klik untuk muat turun</div>` +
      `<table>${rows.join("") || '<tr><td class="hdr">(kosong)</td></tr>'}</table>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  download(res, userId, rel) {
    const full = this.resolveInside(userId, rel);
    if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return send(res, 404, "not found");
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.basename(full)}"`,
      "Content-Length": fs.statSync(full).size,
    });
    fs.createReadStream(full).pipe(res);
  }
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
