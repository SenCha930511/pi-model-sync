import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_NAME = "@sencha930511/pi-model-sync";
const USAGE = "Usage: node scripts/verify-release-tarball.mjs --directory <dir> --tag <vX.Y.Z> --head <commit> [--name <name>] [--github-env <file>] [--test-packed]";

function parseArgs(argv) {
  const options = {
    directory: undefined,
    tag: undefined,
    head: undefined,
    name: DEFAULT_NAME,
    githubEnv: undefined,
    testPacked: false,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--test-packed") {
      if (seen.has(argument)) throw new Error("--test-packed may be supplied only once");
      seen.add(argument);
      options.testPacked = true;
      continue;
    }
    if (!["--directory", "--tag", "--head", "--name", "--github-env"].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`${argument} may be supplied only once`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a nonempty value`);
    index += 1;
    if (argument === "--directory") options.directory = value;
    else if (argument === "--tag") options.tag = value;
    else if (argument === "--head") options.head = value;
    else if (argument === "--name") options.name = value;
    else options.githubEnv = value;
  }
  if (!options.directory) throw new Error("--directory is required");
  if (!options.tag) throw new Error("--tag is required");
  if (!options.head) throw new Error("--head is required");
  return options;
}

function findTarball(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    .map((entry) => entry.name)
    .sort();
  if (entries.length !== 1) {
    throw new Error(`expected exactly one .tgz in ${directory}, found ${entries.length}`);
  }
  return path.resolve(directory, entries[0]);
}

function readPackageMetadata(tarball) {
  const raw = execFileSync("tar", ["-xOf", path.basename(tarball), "package/package.json"], {
    cwd: path.dirname(tarball),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(raw);
}

function verifyMetadata(metadata, options) {
  if (metadata.name !== options.name) {
    throw new Error(`tarball name is ${JSON.stringify(metadata.name)}, expected ${JSON.stringify(options.name)}`);
  }
  if (`v${metadata.version}` !== options.tag) {
    throw new Error(`tarball version is ${JSON.stringify(metadata.version)}, expected tag ${JSON.stringify(options.tag)}`);
  }
  if (metadata.gitHead !== options.head) {
    throw new Error(`tarball gitHead is ${JSON.stringify(metadata.gitHead)}, expected ${JSON.stringify(options.head)}`);
  }
}

function appendGitHubEnv(file, metadata, tarball) {
  fs.appendFileSync(file, `TARBALL=${tarball}\nNAME=${metadata.name}\nVERSION=${metadata.version}\n`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(USAGE);
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  try {
    const tarball = findTarball(options.directory);
    const metadata = readPackageMetadata(tarball);
    verifyMetadata(metadata, options);
    if (options.testPacked) {
      const testPacked = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "test-packed.mjs");
      execFileSync(process.execPath, [testPacked, "--tarball", path.resolve(tarball)], { stdio: "inherit" });
    }
    if (options.githubEnv) appendGitHubEnv(options.githubEnv, metadata, tarball);
    console.log(`Verified ${metadata.name}@${metadata.version} from ${metadata.gitHead}.`);
  } catch (error) {
    console.error(`Release tarball verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
