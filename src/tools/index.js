// Tool registry. Each tool is { name, description, parameters (JSON schema),
// handler(args, ctx) -> object }. The agent converts assistant tool_calls into
// handler calls and feeds results back as tool-role messages.

import * as shell from "./shell.js";
import * as files from "./files.js";
import * as apk from "./apk.js";

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }
  register(tool) {
    this.tools.set(tool.name, tool);
  }
  names() {
    return [...this.tools.keys()];
  }
  schemas() {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  async invoke(name, rawArgs, ctx) {
    const tool = this.tools.get(name);
    if (!tool) return safeJson({ error: `unknown tool: ${name}` });
    let args;
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
      if (typeof args !== "object" || args === null) args = { value: args };
    } catch (e) {
      return safeJson({ error: `invalid JSON arguments: ${e.message}`, raw: String(rawArgs).slice(0, 400) });
    }
    let result;
    try {
      result = await tool.handler(args, ctx);
    } catch (e) {
      result = { error: `${e.name}: ${e.message}`, trace: ctx.debug ? e.stack : undefined };
    }
    if (typeof result !== "object" || result === null) result = { result };
    return safeJson(result);
  }
}

function safeJson(obj, maxChars = 60000) {
  let s = JSON.stringify(obj);
  if (s.length > maxChars) {
    const t = typeof obj === "object" && obj ? { ...obj } : { result: obj };
    t._truncated = true;
    t._note = `output trimmed from ${s.length} to ${maxChars} chars — save large output to files and read them back`;
    for (const key of ["stdout", "stderr", "content", "preview"]) {
      if (typeof t[key] === "string") t[key] = t[key].slice(0, Math.floor(maxChars / 2)) + "\n…[trimmed]…";
    }
    s = JSON.stringify(t);
    if (s.length > maxChars) s = s.slice(0, maxChars);
  }
  return s;
}

export function buildRegistry() {
  const reg = new ToolRegistry();
  shell.register(reg);
  files.register(reg);
  apk.register(reg);

  // deliver — the only way a file reaches the user over Telegram.
  reg.register({
    name: "deliver",
    description:
      "Send a FINISHED file to the user (e.g. the final signed/aligned APK, an AAB, or a packaged zip). This is the ONLY way a file reaches the user — intermediate artefacts (smali/java, resources, modified images) are NOT sent automatically. Call this once at the end with the final deliverable(s).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the finished file to send." },
        caption: { type: "string", description: "Optional caption shown with the file." },
      },
      required: ["path"],
    },
    handler: async (args, ctx) => {
      if (!args.path) return { error: "`path` is required" };
      const path0 = await import("node:path");
      const fs0 = await import("node:fs");
      let p = args.path;
      if (!path0.isAbsolute(p)) p = path0.join(ctx.workspace, p);
      if (!fs0.existsSync(p) || !fs0.statSync(p).isFile()) return { error: `file not found: ${p}` };
      if (!ctx.deliverables.includes(p)) ctx.deliverables.push(p);
      if (args.caption) ctx.deliverCaptions[p] = args.caption;
      return { delivered: p, size: fs0.statSync(p).size, note: "Queued to send to the user." };
    },
  });

  return reg;
}
