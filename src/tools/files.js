// File-system tools: read/write/edit/list/glob/grep/mkdir/move/remove.

import fs from "node:fs";
import path from "node:path";
import { resolvePath } from "./util.js";

function walk(root, onFile, max = 5000) {
  const stack = [root];
  let count = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else {
        if (onFile(full) === false) return;
        if (++count >= max) return;
      }
    }
  }
}

// Very small glob → RegExp (supports * ? and **).
function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$");
}

export function register(reg) {
  reg.register({
    name: "read_file",
    description:
      "Read a file. UTF-8 text is returned as-is; binary content is returned as hex. Supports offset/max_bytes for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        max_bytes: { type: "number", description: "Max bytes to read (default 200000)." },
        offset: { type: "number", description: "Byte offset to start at (default 0)." },
      },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      const p = resolvePath(args.path, ctx.workspace);
      if (!fs.existsSync(p)) return { error: `file not found: ${p}` };
      const st = fs.statSync(p);
      if (st.isDirectory()) return { error: `path is a directory: ${p}` };
      const maxBytes = Number(args.max_bytes) || 200000;
      const offset = Number(args.offset) || 0;
      const fd = fs.openSync(p, "r");
      try {
        const buf = Buffer.alloc(Math.min(maxBytes, Math.max(0, st.size - offset)));
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
        const data = buf.subarray(0, bytesRead);
        let content;
        let isBinary = false;
        const text = data.toString("utf8");
        if (text.includes("\uFFFD") && containsNul(data)) {
          content = data.toString("hex");
          isBinary = true;
        } else {
          content = text;
        }
        return {
          path: p,
          size: st.size,
          offset,
          bytes_read: bytesRead,
          is_binary: isBinary,
          content,
          truncated: offset + bytesRead < st.size,
        };
      } finally {
        fs.closeSync(fd);
      }
    },
  });

  reg.register({
    name: "write_file",
    description: "Write (or append) UTF-8 text to a file, creating parent dirs.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        append: { type: "boolean" },
      },
      required: ["path", "content"],
    },
    handler: async (args, ctx) => {
      if (typeof args.content !== "string") return { error: "`content` must be a string" };
      const p = resolvePath(args.path, ctx.workspace);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content, { flag: args.append ? "a" : "w" });
      return {
        path: p,
        bytes: Buffer.byteLength(args.content),
        appended: !!args.append,
      };
    },
  });

  reg.register({
    name: "edit_file",
    description:
      "Replace an exact substring in a text file. Errors if old_string is missing or ambiguous (unless replace_all).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string"],
    },
    handler: async (args, ctx) => {
      const p = resolvePath(args.path, ctx.workspace);
      if (!fs.existsSync(p)) return { error: `file not found: ${p}` };
      const original = fs.readFileSync(p, "utf8");
      const old = args.old_string;
      const next = args.new_string ?? "";
      const count = original.split(old).length - 1;
      if (count === 0) return { error: "old_string not found" };
      if (count > 1 && !args.replace_all) {
        return {
          error: `old_string occurs ${count} times — pass replace_all=true or include more context`,
        };
      }
      const updated = args.replace_all
        ? original.split(old).join(next)
        : original.replace(old, next);
      fs.writeFileSync(p, updated);
      return { path: p, replaced: args.replace_all ? count : 1 };
    },
  });

  reg.register({
    name: "list_dir",
    description: "List entries in a directory (files + subdirectories).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        show_hidden: { type: "boolean" },
      },
    },
    handler: async (args, ctx) => {
      const p = resolvePath(args.path || ".", ctx.workspace);
      if (!fs.existsSync(p)) return { error: `not found: ${p}` };
      const st = fs.statSync(p);
      if (!st.isDirectory()) return { error: `not a directory: ${p}` };
      const entries = [];
      for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!args.show_hidden && e.name.startsWith(".")) continue;
        let size = null;
        try {
          if (e.isFile()) size = fs.statSync(path.join(p, e.name)).size;
        } catch {
          /* ignore */
        }
        entries.push({ name: e.name, type: e.isDirectory() ? "dir" : "file", size });
      }
      return { path: p, count: entries.length, entries: entries.slice(0, 500) };
    },
  });

  reg.register({
    name: "glob",
    description: "Find files matching a glob pattern (supports * ? **).",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Root to search (default workspace)." },
        max_results: { type: "number" },
      },
      required: ["pattern"],
    },
    handler: async (args, ctx) => {
      const root = resolvePath(args.path || ".", ctx.workspace);
      if (!fs.existsSync(root)) return { error: `not found: ${root}` };
      const re = globToRe(args.pattern);
      const baseRe = globToRe(args.pattern.replace(/.*\//, ""));
      const maxResults = Number(args.max_results) || 500;
      const matches = [];
      walk(root, (full) => {
        const rel = path.relative(root, full);
        if (re.test(rel) || baseRe.test(path.basename(full))) {
          matches.push(full);
          if (matches.length >= maxResults) return false;
        }
      });
      return { root, pattern: args.pattern, matches, truncated: matches.length >= maxResults };
    },
  });

  reg.register({
    name: "grep",
    description: "Search file contents for a regular expression.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "Root to search (default workspace)." },
        glob: { type: "string", description: "Only search files matching this glob." },
        ignore_case: { type: "boolean" },
        max_results: { type: "number" },
      },
      required: ["pattern"],
    },
    handler: async (args, ctx) => {
      const root = resolvePath(args.path || ".", ctx.workspace);
      if (!fs.existsSync(root)) return { error: `not found: ${root}` };
      let re;
      try {
        re = new RegExp(args.pattern, args.ignore_case ? "i" : "");
      } catch (e) {
        return { error: `invalid regex: ${e.message}` };
      }
      const fileRe = args.glob ? globToRe(args.glob) : null;
      const maxResults = Number(args.max_results) || 200;
      const results = [];
      walk(root, (full) => {
        if (fileRe && !fileRe.test(path.basename(full))) return;
        let text;
        try {
          const st = fs.statSync(full);
          if (st.size > 4 * 1024 * 1024) return; // skip huge files
          text = fs.readFileSync(full, "utf8");
        } catch {
          return;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push({ file: full, line: i + 1, text: lines[i].slice(0, 300) });
            if (results.length >= maxResults) return false;
          }
        }
      });
      return { root, pattern: args.pattern, count: results.length, results };
    },
  });

  reg.register({
    name: "mkdir",
    description: "Create a directory (recursive).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      const p = resolvePath(args.path, ctx.workspace);
      fs.mkdirSync(p, { recursive: true });
      return { path: p, created: true };
    },
  });

  reg.register({
    name: "move",
    description: "Move or rename a file/directory.",
    parameters: {
      type: "object",
      properties: { src: { type: "string" }, dest: { type: "string" } },
      required: ["src", "dest"],
    },
    handler: async (args, ctx) => {
      const src = resolvePath(args.src, ctx.workspace);
      const dest = resolvePath(args.dest, ctx.workspace);
      if (!fs.existsSync(src)) return { error: `src not found: ${src}` };
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      return { src, dest, moved: true };
    },
  });

  reg.register({
    name: "remove",
    description: "Delete a file or directory (recursive for directories).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      const p = resolvePath(args.path, ctx.workspace);
      if (!fs.existsSync(p)) return { error: `not found: ${p}` };
      fs.rmSync(p, { recursive: true, force: true });
      return { path: p, removed: true };
    },
  });
}

function containsNul(buf) {
  for (let i = 0; i < Math.min(buf.length, 8000); i++) if (buf[i] === 0) return true;
  return false;
}
