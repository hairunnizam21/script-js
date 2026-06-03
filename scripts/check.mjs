#!/usr/bin/env node
// Syntax-check every JS source file (bin/suzu + all of src/) with `node --check`.
// Exits non-zero if any file fails — used by `npm run check` and CI.

import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

const files = [];
const binSuzu = path.join(root, "bin", "suzu");
if (existsSync(binSuzu)) files.push(binSuzu);
const srcDir = path.join(root, "src");
if (existsSync(srcDir)) files.push(...walk(srcDir));

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    failed++;
    process.stderr.write(`✗ ${path.relative(root, f)}\n${e.stderr?.toString() || e.message}\n`);
  }
}

if (failed) {
  console.error(`\nSyntax check FAILED: ${failed}/${files.length} file(s) have errors.`);
  process.exit(1);
}
console.log(`Syntax check OK: ${files.length} file(s).`);
