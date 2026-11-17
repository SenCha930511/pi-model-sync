import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommandProbe } from "./command-probe.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Shipped sources first, then tests, then the installed-host contract probe.
const projects = [
  path.join(root, "scripts", "tsconfig.typecheck.json"),
  path.join(root, "scripts", "tsconfig.tests.json"),
  path.join(root, "scripts", "tsconfig.hosts.json"),
];
const localTsc = path.join(root, ".github", "omp-tools", "node_modules", "typescript", "bin", "tsc");
const requiredTypes = ["node", "bun"].map((name) => path.join(root, ".github", "omp-tools", "node_modules", "@types", name));

for (const types of requiredTypes) {
  if (!existsSync(types)) {
    console.error(`Missing ${path.relative(root, types)}. Run "npm ci --prefix .github/omp-tools" first.`);
    process.exit(1);
  }
}

function runTsc(tsconfig) {
  if (existsSync(localTsc)) {
    return spawnSync(process.execPath, [localTsc, "-p", tsconfig], { cwd: root, stdio: "inherit" });
  }
  const command = process.platform === "win32" ? "tsc.cmd" : "tsc";
  const resolved = resolveCommandProbe(command, ["-p", tsconfig]);
  return spawnSync(resolved.command, resolved.args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
  });
}

for (const tsconfig of projects) {
  const result = runTsc(tsconfig);
  if (result.error) {
    console.error(`Failed to launch tsc: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Typecheck failed: ${path.relative(root, tsconfig)}`);
    process.exit(result.status ?? 1);
  }
}
