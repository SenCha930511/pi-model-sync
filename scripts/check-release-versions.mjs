import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@sencha930511/pi-model-sync";
const STABLE_VERSION = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const VERSION_PATTERN = new RegExp(`^${STABLE_VERSION}(?![\\s\\S])`);
const CHANGELOG_HEADING = new RegExp(`^## (${STABLE_VERSION}) — (\\d{4}-\\d{2}-\\d{2})$`);
const GIT_INSTALL_PATTERN = /git:github\.com\/SenCha930511\/pi-model-sync@v([^\s`'")]+)/g;
const AGENTS_VERSION_PATTERN = /MIT license, v([^,\r\n]+), published to npm as/g;
const USAGE = "Usage: node scripts/check-release-versions.mjs [--root <dir>] [--release --tag <tag> [--notes-output <file>]]";

function parseArgs(argv) {
  const options = {
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    release: false,
    tag: undefined,
    notesOutput: undefined,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--release") {
      if (seen.has(argument)) throw new Error("--release may be supplied only once");
      seen.add(argument);
      options.release = true;
      continue;
    }
    if (argument !== "--root" && argument !== "--tag" && argument !== "--notes-output") {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (seen.has(argument)) throw new Error(`${argument} may be supplied only once`);
    seen.add(argument);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a nonempty value`);
    index += 1;
    if (argument === "--root") options.root = path.resolve(value);
    else if (argument === "--tag") options.tag = value;
    else options.notesOutput = path.resolve(value);
  }
  if (options.release && options.tag === undefined) throw new Error("--release requires --tag");
  if (!options.release && options.tag !== undefined) throw new Error("--tag requires --release");
  if (!options.release && options.notesOutput !== undefined) throw new Error("--notes-output requires --release");
  return options;
}

function readText(root, relative, problems) {
  try {
    return fs.readFileSync(path.join(root, relative), "utf8");
  } catch {
    problems.push(`${relative}: could not be read`);
    return undefined;
  }
}

function readJson(root, relative, problems) {
  const text = readText(root, relative, problems);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    problems.push(`${relative}: is not valid JSON`);
    return undefined;
  }
}

function versionObservation(source, version, problems) {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    problems.push(`${source}: expected a stable X.Y.Z version string`);
    return undefined;
  }
  return { source, version };
}

function patternObservations(root, relative, label, pattern, expectedCount, problems) {
  const text = readText(root, relative, problems);
  if (text === undefined) return [];
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== expectedCount) {
    problems.push(`${label}: expected ${expectedCount} version declaration(s), found ${matches.length}`);
    return [];
  }
  return matches
    .map((match, index) => {
      const source = expectedCount === 1 ? label : `${label} #${index + 1}`;
      return versionObservation(source, match[1], problems);
    })
    .filter(Boolean);
}

function collectVersions(root) {
  const problems = [];
  const rootPackage = readJson(root, "package.json", problems);
  if (rootPackage !== undefined && rootPackage?.name !== PACKAGE_NAME) {
    problems.push(`package.json name: expected ${PACKAGE_NAME}`);
  }
  const rootVersion = versionObservation("package.json version", rootPackage?.version, problems);
  const observations = [
    rootVersion,
    ...patternObservations(root, "README.md", "README.md git tag pin", GIT_INSTALL_PATTERN, 2, problems),
    ...patternObservations(root, "llms.txt", "llms.txt git tag pin", GIT_INSTALL_PATTERN, 2, problems),
    ...patternObservations(root, "AGENTS.md", "AGENTS.md overview version", AGENTS_VERSION_PATTERN, 1, problems),
  ].filter(Boolean);
  if (rootVersion) {
    for (const observation of observations) {
      if (observation.version !== rootVersion.version) {
        problems.push(`${observation.source}: ${observation.version} does not match package.json version ${rootVersion.version}`);
      }
    }
  }
  return { expected: rootVersion?.version, problems };
}

function checkRelease(root, options, expected, problems) {
  if (expected && options.tag !== `v${expected}`) {
    problems.push(`release tag: expected v${expected}`);
  }
  const text = readText(root, "CHANGELOG.md", problems);
  if (text === undefined) return;
  const rawLines = text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const lines = [];
  let fence;
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    const opening = line.trimStart();
    if (fence !== undefined) {
      if (opening.startsWith(fence)) fence = undefined;
      continue;
    }
    if (opening.startsWith("```") || opening.startsWith("~~~")) {
      fence = opening.slice(0, 3);
      continue;
    }
    lines.push({ line, rawIndex: index });
  }
  if (lines[0]?.line !== "# Changelog") problems.push("CHANGELOG.md: must start with # Changelog");
  const headings = lines.filter(({ line }) => /^##(?!#)/.test(line));
  const first = headings[0];
  if (!first) {
    problems.push("CHANGELOG.md: missing a ## version heading");
    return;
  }
  const match = first.line.match(CHANGELOG_HEADING);
  if (!match) {
    problems.push("CHANGELOG.md: first ## heading must be ## X.Y.Z — YYYY-MM-DD");
  } else {
    const date = new Date(`${match[2]}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== match[2]) {
      problems.push("CHANGELOG.md: first ## heading must contain a valid YYYY-MM-DD date");
    }
    if (expected && match[1] !== expected) {
      problems.push(`CHANGELOG.md: first ## heading is ${match[1]}, expected ${expected}`);
    }
  }
  if (expected) {
    const escaped = expected.replaceAll(".", "\\.");
    const targetHeading = new RegExp(`^## ${escaped}(?:\\s|$)`);
    if (headings.slice(1).some(({ line }) => targetHeading.test(line))) {
      problems.push(`CHANGELOG.md: duplicate heading for target version ${expected}`);
    }
  }
  const sectionLines = rawLines.slice(first.rawIndex + 1, headings[1]?.rawIndex);
  while (sectionLines.length > 0 && sectionLines[0].trim() === "") sectionLines.shift();
  while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1].trim() === "") sectionLines.pop();
  const body = sectionLines.join("\n");
  if (!body) {
    problems.push(`CHANGELOG.md: release section for ${expected} must not be empty`);
  }
  if (problems.length === 0 && options.notesOutput) {
    fs.mkdirSync(path.dirname(options.notesOutput), { recursive: true });
    fs.writeFileSync(options.notesOutput, `${body}\n`);
  }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(USAGE);
  console.error(error.message);
  process.exitCode = 2;
}

if (options) {
  const { expected, problems } = collectVersions(options.root);
  if (options.release) checkRelease(options.root, options, expected, problems);
  if (problems.length > 0) {
    console.error("Release version check failed:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`All six version declarations agree on ${expected}.`);
    if (options.release) console.log(`Tag and changelog match ${options.tag}.`);
  }
}
