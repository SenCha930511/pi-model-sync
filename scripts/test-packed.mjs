import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveCommandProbe } from "./command-probe.mjs";

const execute = promisify(execFile);
const PACKAGE_NAME = "@sencha930511/pi-model-sync";
const EXPECTED_FILES = ["LICENSE", "README.md", "config.ts", "index.ts", "llms.txt", "package.json"];

const runNpm = (args, options) => {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const resolved = resolveCommandProbe(command, args);
  return execute(resolved.command, resolved.args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
  });
};

function resolveOmpCommand(root) {
  if (process.env.PI_MODEL_SYNC_OMP_COMMAND) return process.env.PI_MODEL_SYNC_OMP_COMMAND;
  const localOmp = path.join(
    root,
    ".github",
    "omp-tools",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "omp.cmd" : "omp",
  );
  if (existsSync(localOmp)) return localOmp;
  return process.platform === "win32" ? "omp.cmd" : "omp";
}

async function measureUnpackedSize(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await measureUnpackedSize(fullPath);
    else total += (await stat(fullPath)).size;
  }
  return total;
}

const tarballArgIndex = process.argv.indexOf("--tarball");
assert.ok(tarballArgIndex === -1 || Boolean(process.argv[tarballArgIndex + 1]), "--tarball requires a tarball path");
const suppliedTarball = tarballArgIndex === -1 ? undefined : path.resolve(process.argv[tarballArgIndex + 1]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "pi-model-sync-packed-"));

try {
  let tarballPath;
  let files;
  let packedSize;
  let unpackedSize;

  if (suppliedTarball) {
    tarballPath = suppliedTarball;
    packedSize = (await stat(tarballPath)).size;
    const listed = await execute("tar", ["-tzf", path.basename(tarballPath)], { cwd: path.dirname(tarballPath) });
    files = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith("/"))
      .map((line) => line.replace(/^package\//, ""));
  } else {
    const packed = JSON.parse((await runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
      cwd: root,
    })).stdout);
    const artifact = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
    tarballPath = path.join(temporary, artifact.filename);
    files = artifact.files.map((file) => file.path);
    packedSize = artifact.size;
    unpackedSize = artifact.unpackedSize;
  }

  assert.deepEqual([...files].sort(), [...EXPECTED_FILES].sort(), `unexpected packed files: ${JSON.stringify(files)}`);
  console.log(`Packed ${path.basename(tarballPath)}: ${packedSize} bytes (${files.length} files)`);

  const install = path.join(temporary, "consumer");
  await runNpm(
    [
      "install",
      "--prefix",
      install,
      tarballPath,
      "--omit=dev",
      "--omit=peer",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: temporary, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
  );

  const installed = path.join(install, "node_modules", "@sencha930511", "pi-model-sync");
  await access(path.join(installed, "index.ts"));
  await access(path.join(installed, "config.ts"));
  await access(path.join(installed, "llms.txt"));
  const installedPkg = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(installedPkg.dependencies, undefined, "package must not declare runtime dependencies");

  const topModules = (await readdir(path.join(install, "node_modules"))).filter((name) => !name.startsWith("."));
  assert.deepEqual(topModules, ["@sencha930511"], `runtime install must not pull external dependencies: ${JSON.stringify(topModules)}`);
  const scopedModules = await readdir(path.join(install, "node_modules", "@sencha930511"));
  assert.deepEqual(scopedModules, ["pi-model-sync"]);

  unpackedSize ??= await measureUnpackedSize(installed);
  assert.ok(unpackedSize < 512 * 1024, `${PACKAGE_NAME} unpacked size unexpectedly large: ${unpackedSize} bytes`);
  console.log(`Clean production install: ${unpackedSize} unpacked bytes, zero runtime dependencies: PASS`);

  const installedEntry = path.join(installed, "index.ts");
  await execute(
    "bun",
    ["-e", `const m = await import(${JSON.stringify(pathToFileURL(installedEntry).href)}); if (typeof m.default !== "function") process.exit(1);`],
    { cwd: temporary, timeout: 30_000 },
  );
  console.log("Installed tarball Bun import smoke check: PASS");

  const ompHome = path.join(temporary, "omp-home");
  const ompEnv = {
    ...process.env,
    HOME: ompHome,
    USERPROFILE: ompHome,
    PI_CODING_AGENT_DIR: path.join(ompHome, "agent"),
  };
  const ompCommand = resolveOmpCommand(root);
  const modelsProbe = resolveCommandProbe(ompCommand, ["models", "--no-extensions", "-e", installedEntry, "--json"]);
  const catalog = await execute(modelsProbe.command, modelsProbe.args, {
    cwd: temporary,
    env: ompEnv,
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === "win32",
  });
  assert.ok(!catalog.stderr.includes("Failed to load extension"), `OMP reported extension load failure:\n${catalog.stderr}`);
  const parsed = JSON.parse(catalog.stdout);
  assert.ok(Array.isArray(parsed.models));
  console.log("Installed npm tarball loads in OMP with an isolated home: PASS");
} finally {
  await rm(temporary, { recursive: true, force: true });
  console.log("Removed temporary package and consumer installation");
}
