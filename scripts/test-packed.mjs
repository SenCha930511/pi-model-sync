import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveCommandProbe } from "./command-probe.mjs";

const execute = promisify(execFile);
const PACKAGE_NAME = "@sencha930511/pi-model-sync";
const EXPECTED_FILES = ["LICENSE", "README.md", "adapters.ts", "config.ts", "index.ts", "llms.txt", "package.json"];

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

function resolvePiCommand(root) {
  if (process.env.PI_MODEL_SYNC_PI_COMMAND) return { command: process.env.PI_MODEL_SYNC_PI_COMMAND, args: [] };
  // Run the local CLI through Node directly so Windows does not need a .cmd shim with piped stdin.
  const localPackage = path.join(root, ".github", "omp-tools", "node_modules", "@earendil-works", "pi-coding-agent");
  const manifestPath = path.join(localPackage, "package.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
    assert.ok(typeof bin === "string", "upstream pi package does not declare a pi bin");
    return { command: process.execPath, args: [path.join(localPackage, bin)] };
  }
  return { command: process.platform === "win32" ? "pi.cmd" : "pi", args: [] };
}

function runWithInput(command, args, input, { timeout, ...options }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeout} ms:\n${stderr}`));
    }, timeout);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
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
  await access(path.join(installed, "adapters.ts"));
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

  const piHome = path.join(temporary, "pi-home");
  const piEnv = {
    ...process.env,
    HOME: piHome,
    USERPROFILE: piHome,
    PI_CODING_AGENT_DIR: path.join(piHome, "agent"),
    PI_OFFLINE: "1",
  };
  const piCommand = resolvePiCommand(root);
  const piProbe = resolveCommandProbe(piCommand.command, [
    ...piCommand.args,
    "--mode",
    "rpc",
    "--no-session",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "-e",
    installedEntry,
  ]);
  const rpc = await runWithInput(piProbe.command, piProbe.args, `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`, {
    cwd: temporary,
    env: piEnv,
    timeout: 120_000,
    // Only the cmd.exe wrapper from resolveCommandProbe needs verbatim (pre-quoted) arguments.
    windowsVerbatimArguments: piProbe.command !== piCommand.command,
  });
  assert.equal(rpc.code, 0, `upstream pi RPC probe exited with ${rpc.code}:\n${rpc.stderr}`);
  assert.ok(!`${rpc.stdout}\n${rpc.stderr}`.includes("Failed to load extension"), `upstream pi reported extension load failure:\n${rpc.stderr}`);
  const response = rpc.stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .find((record) => record.type === "response" && record.id === "commands");
  assert.ok(response?.success, `upstream pi get_commands failed:\n${rpc.stdout}\n${rpc.stderr}`);
  const command = response.data.commands.find((entry) => entry.name === "model-sync");
  assert.equal(command?.source, "extension", `upstream pi did not register /model-sync: ${JSON.stringify(response.data.commands)}`);
  // Compare the package-relative suffix: Windows may report a long or short (8.3) temp path.
  assert.ok(
    String(command.sourceInfo?.path).replaceAll("\\", "/").endsWith("node_modules/@sencha930511/pi-model-sync/index.ts"),
    `/model-sync was registered from an unexpected path: ${command.sourceInfo?.path}`,
  );
  console.log("Installed npm tarball registers /model-sync in upstream pi with an isolated home: PASS");
} finally {
  await rm(temporary, { recursive: true, force: true });
  console.log("Removed temporary package and consumer installation");
}
