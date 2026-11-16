import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommandProbe } from "./command-probe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsconfig = path.join(root, "scripts", "tsconfig.typecheck.json");
const localTsc = path.join(root, ".github", "omp-tools", "node_modules", "typescript", "bin", "tsc");
const localNodeTypes = path.join(root, ".github", "omp-tools", "node_modules", "@types", "node");

if (!existsSync(localNodeTypes)) {
  console.error('Missing .github/omp-tools/node_modules/@types/node. Run "npm ci --prefix .github/omp-tools" first.');
  process.exit(1);
}

let result;
if (existsSync(localTsc)) {
  result = spawnSync(process.execPath, [localTsc, "-p", tsconfig], { cwd: root, stdio: "inherit" });
} else {
  const command = process.platform === "win32" ? "tsc.cmd" : "tsc";
  const resolved = resolveCommandProbe(command, ["-p", tsconfig]);
  result = spawnSync(resolved.command, resolved.args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
  });
}

if (result.error) {
  console.error(`Failed to launch tsc: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
