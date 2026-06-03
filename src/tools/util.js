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
// very large output.
export function runCommand({
  command,
  argv,
  cwd,
  timeout = 180000,
  env,
  maxChars = 20000,
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

    child.stdout?.on("data", (d) => {
      out += d.toString();
      if (out.length > maxChars * 2) out = out.slice(-maxChars * 2);
    });
    child.stderr?.on("data", (d) => {
      err += d.toString();
      if (err.length > maxChars * 2) err = err.slice(-maxChars * 2);
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
