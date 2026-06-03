// Generic command execution tools: shell (bash -c) and exec (argv directly).

import fs from "node:fs";
import { resolvePath, runCommand } from "./util.js";

function resolveCwd(cwd, workspace) {
  const dir = resolvePath(cwd, workspace);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

export function register(reg) {
  reg.register({
    name: "shell",
    description:
      "Run a shell command (bash -c). Use for general-purpose CLI tasks (apktool, jadx, gradlew, etc.). Working directory defaults to the user workspace. Returns stdout/stderr/exit_code; large output is trimmed.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line, run via bash -c." },
        cwd: {
          type: "string",
          description: "Working directory (relative paths resolve under the workspace).",
        },
        timeout: { type: "number", description: "Timeout in seconds (default 180)." },
        env: {
          type: "object",
          description: "Extra environment variables.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["command"],
    },
    handler: async (args, ctx) => {
      if (!args.command || typeof args.command !== "string") {
        return { error: "`command` (string) is required" };
      }
      const cwd = resolveCwd(args.cwd, ctx.workspace);
      return runCommand({
        command: args.command,
        cwd,
        timeout: (Number(args.timeout) || 180) * 1000,
        env: args.env && typeof args.env === "object" ? args.env : undefined,
      });
    },
  });

  reg.register({
    name: "exec",
    description:
      "Run a process directly (no shell interpolation). Use when you want to avoid shell quoting issues.",
    parameters: {
      type: "object",
      properties: {
        argv: {
          type: "array",
          items: { type: "string" },
          description: 'Argument vector, e.g. ["apktool", "d", "foo.apk"].',
        },
        cwd: { type: "string" },
        timeout: { type: "number" },
      },
      required: ["argv"],
    },
    handler: async (args, ctx) => {
      if (!Array.isArray(args.argv) || !args.argv.length) {
        return { error: "`argv` (array of strings) is required" };
      }
      const cwd = resolveCwd(args.cwd, ctx.workspace);
      return runCommand({
        argv: args.argv.map(String),
        cwd,
        timeout: (Number(args.timeout) || 180) * 1000,
      });
    },
  });
}
