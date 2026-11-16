// Runtime load-time graph check + Bun import smoke test.
//
// pi-model-sync must remain zero-dependency at runtime: only `node:*` builtins
// and local relative modules may appear as runtime imports. Type-only host
// imports (e.g. `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`)
// are erased before execution and are allowed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const transpiler = new Bun.Transpiler({ loader: "ts" });
const root = path.resolve(import.meta.dir, "..");
const seen = new Set<string>();
const offenders: Array<{ file: string; spec: string }> = [];

function resolveRelative(fromDir: string, spec: string): string {
  const base = path.resolve(fromDir, spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const ext of [".ts", ".mts", ".mjs", ".js"]) {
    if (fs.existsSync(`${base}${ext}`)) return `${base}${ext}`;
  }
  return base;
}

function walk(file: string): void {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  const code = fs.readFileSync(resolved, "utf8");
  for (const item of transpiler.scanImports(code)) {
    const spec = item.path;
    if (item.kind === "import-type" || spec.startsWith("node:")) continue;
    if (!spec.startsWith(".") && !path.isAbsolute(spec)) {
      offenders.push({ file: path.relative(root, resolved), spec });
      continue;
    }
    const next = resolveRelative(path.dirname(resolved), spec);
    if (next.endsWith(".ts") || next.endsWith(".mts") || next.endsWith(".mjs")) walk(next);
  }
}

walk(path.join(root, "index.ts"));

const files = [...seen].map((file) => path.relative(root, file)).sort();
assert.deepEqual(files, ["adapters.ts", "config.ts", "index.ts"]);
assert.deepEqual(
  offenders,
  [],
  `Runtime bare package imports are forbidden (pi-model-sync has zero runtime dependencies): ${JSON.stringify(offenders)}`,
);

const mod = await import("../index.ts");
assert.equal(typeof mod.default, "function", "index.ts must default-export the extension function");

console.log(`Load-time graph (${files.join(", ")}) has zero runtime package imports and imports cleanly: PASS`);
