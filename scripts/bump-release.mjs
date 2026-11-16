import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STABLE_VERSION = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const VERSION_PATTERN = new RegExp(`^${STABLE_VERSION}(?![\\s\\S])`);
const GIT_INSTALL_PATTERN = /(git:github\.com\/SenCha930511\/pi-model-sync@v)([^\s`'")]+)/g;
const AGENTS_VERSION_PATTERN = /(MIT license, v)([^,\r\n]+)(, published to npm as)/g;
const USAGE = "Usage: node scripts/bump-release.mjs <X.Y.Z> [--root <dir>]";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CHECKER_PATH = fileURLToPath(new URL("./check-release-versions.mjs", import.meta.url));
const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

export function parseArgs(argv, defaultRoot = PROJECT_ROOT) {
  const options = { root: defaultRoot, version: undefined };
  let rootSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      if (rootSeen) throw new Error("--root may be supplied only once");
      rootSeen = true;
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--root requires a nonempty value");
      options.root = path.resolve(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`unknown argument: ${argument}`);
    if (options.version !== undefined) throw new Error(`unexpected argument: ${argument}`);
    options.version = argument;
  }
  if (options.version === undefined) throw new Error("a target X.Y.Z version is required");
  if (!VERSION_PATTERN.test(options.version)) throw new Error(`invalid target version: ${options.version}`);
  return options;
}

function readText(root, relative) {
  const file = path.join(root, relative);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw new Error(`${relative}: could not be read (${error.code ?? error.message})`);
  }
  let mode;
  try {
    mode = fs.statSync(file).mode;
  } catch (error) {
    throw new Error(`${relative}: could not be inspected (${error.code ?? error.message})`);
  }
  return { bytes, mode, text: bytes.toString("utf8") };
}

function parseJson(text, relative) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${relative}: is not valid JSON`);
  }
}

// Records exact character spans for JSON member values without reserializing,
// preserving existing formatting and line endings.
function findMemberSpans(text, keep) {
  const spans = new Map();
  const primitive = /(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/y;
  const skipWhitespace = (index) => {
    let cursor = index;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    return cursor;
  };
  const stringEnd = (index) => {
    let cursor = index + 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (text[cursor] === '"') return cursor + 1;
      cursor += 1;
    }
    throw new Error("unterminated JSON string");
  };
  const parseValue = (index, keys) => {
    const cursor = skipWhitespace(index);
    const character = text[cursor];
    if (character === "{") return parseObject(cursor, keys);
    if (character === "[") return parseArray(cursor, keys);
    if (character === '"') return stringEnd(cursor);
    primitive.lastIndex = cursor;
    const match = primitive.exec(text);
    if (!match) throw new Error("unexpected JSON token");
    return cursor + match[0].length;
  };
  const parseObject = (index, keys) => {
    let cursor = skipWhitespace(index + 1);
    if (text[cursor] === "}") return cursor + 1;
    while (true) {
      cursor = skipWhitespace(cursor);
      if (text[cursor] !== '"') throw new Error("expected a JSON object key");
      const keyEnd = stringEnd(cursor);
      const key = JSON.parse(text.slice(cursor, keyEnd));
      cursor = skipWhitespace(keyEnd);
      if (text[cursor] !== ":") throw new Error("expected a JSON colon");
      const valueStart = skipWhitespace(cursor + 1);
      const valueEnd = parseValue(valueStart, [...keys, key]);
      const memberKeys = [...keys, key];
      if (keep(memberKeys)) spans.set(JSON.stringify(memberKeys), { start: valueStart, end: valueEnd });
      cursor = skipWhitespace(valueEnd);
      if (text[cursor] === ",") {
        cursor += 1;
        continue;
      }
      if (text[cursor] === "}") return cursor + 1;
      throw new Error("expected a JSON comma or closing brace");
    }
  };
  const parseArray = (index, keys) => {
    let cursor = skipWhitespace(index + 1);
    if (text[cursor] === "]") return cursor + 1;
    let element = 0;
    while (true) {
      cursor = skipWhitespace(cursor);
      const valueEnd = parseValue(cursor, [...keys, element]);
      cursor = skipWhitespace(valueEnd);
      if (text[cursor] === ",") {
        element += 1;
        cursor += 1;
        continue;
      }
      if (text[cursor] === "]") return cursor + 1;
      throw new Error("expected a JSON comma or closing bracket");
    }
  };
  parseValue(0, []);
  return spans;
}

function replaceSpans(text, replacements, relative) {
  const ordered = [...replacements].sort((left, right) => right.start - left.start);
  let result = text;
  let boundary = text.length + 1;
  for (const replacement of ordered) {
    if (replacement.end > boundary) throw new Error(`${relative}: overlapping version declarations`);
    if (text.slice(replacement.start, replacement.end) !== replacement.expected) {
      throw new Error(`${relative}: version declaration does not contain the current version`);
    }
    result = result.slice(0, replacement.start) + replacement.replacement + result.slice(replacement.end);
    boundary = replacement.start;
  }
  return result;
}

function editRecord(relative, file, text, declarations) {
  return { relative, mode: file.mode, before: file.bytes, after: Buffer.from(text, "utf8"), declarations };
}

function packageJsonEdit(root, current, target) {
  const relative = "package.json";
  const file = readText(root, relative);
  parseJson(file.text, relative);
  const spans = findMemberSpans(file.text, (keys) => keys.length === 1 && keys[0] === "version");
  const span = spans.get(JSON.stringify(["version"]));
  if (!span) throw new Error(`${relative}: missing version`);
  const replacements = [{
    start: span.start,
    end: span.end,
    expected: JSON.stringify(current),
    replacement: JSON.stringify(target),
  }];
  return editRecord(relative, file, replaceSpans(file.text, replacements, relative), 1);
}

function patternEdit(root, relative, pattern, expectedCount, current, target) {
  const file = readText(root, relative);
  const matches = [...file.text.matchAll(pattern)];
  if (matches.length !== expectedCount) {
    throw new Error(`${relative}: expected ${expectedCount} version declaration(s), found ${matches.length}`);
  }
  const replacements = matches.map((match) => {
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    return {
      start,
      end,
      expected: current,
      replacement: target,
    };
  });
  return editRecord(relative, file, replaceSpans(file.text, replacements, relative), replacements.length);
}

export function planEdits(root, target) {
  if (!VERSION_PATTERN.test(target ?? "")) throw new Error(`invalid target version: ${target}`);
  const packageFile = readText(root, "package.json");
  const packageJson = parseJson(packageFile.text, "package.json");
  const current = packageJson?.version;
  if (typeof current !== "string" || !VERSION_PATTERN.test(current)) {
    throw new Error("package.json version is not a stable X.Y.Z version");
  }
  const edits = [
    packageJsonEdit(root, current, target),
    patternEdit(root, "README.md", GIT_INSTALL_PATTERN, 2, current, target),
    patternEdit(root, "llms.txt", GIT_INSTALL_PATTERN, 2, current, target),
    patternEdit(root, "AGENTS.md", AGENTS_VERSION_PATTERN, 1, current, target),
  ];
  const declarations = edits.reduce((total, edit) => total + edit.declarations, 0);
  if (declarations !== 6) throw new Error(`expected six version declarations, found ${declarations}`);
  return { current, edits, declarations };
}

let temporaryCounter = 0;

function writeAtomically(file, bytes, mode, hooks) {
  temporaryCounter += 1;
  const temporary = `${file}.bump-${process.pid}-${temporaryCounter}.tmp`;
  try {
    hooks.writeFile(temporary, bytes, { mode: mode & 0o7777 });
    fs.chmodSync(temporary, mode & 0o7777);
    hooks.rename(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup after a failed write.
    }
    throw error;
  }
}

function restoreEdits(root, edits, hooks) {
  const failures = [];
  for (const edit of [...edits].reverse()) {
    try {
      writeAtomically(path.join(root, edit.relative), edit.before, edit.mode, hooks);
    } catch (error) {
      failures.push(`${edit.relative}: ${error.message}`);
    }
  }
  return failures;
}

export function applyEdits(root, edits, hooks = {}) {
  const writer = {
    writeFile: hooks.writeFile ?? fs.writeFileSync,
    rename: hooks.rename ?? fs.renameSync,
  };
  const written = [];
  try {
    for (const edit of edits) {
      writeAtomically(path.join(root, edit.relative), edit.after, edit.mode, writer);
      written.push(edit);
    }
  } catch (error) {
    const failures = restoreEdits(root, written, writer);
    const detail = failures.length > 0 ? `rollback failed for ${failures.join(", ")}` : "all changed files were restored";
    const wrapped = new Error(`${error.message}; ${detail}`);
    wrapped.cause = error;
    throw wrapped;
  }
  return written;
}

function runChecker(root, spawn) {
  const result = spawn(process.execPath, [CHECKER_PATH, "--root", root], { encoding: "utf8" });
  if (result.error) throw new Error(`could not run check-release-versions.mjs: ${result.error.message}`);
  return result;
}

export function run(argv, hooks = {}) {
  const spawn = hooks.spawn ?? spawnSync;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(USAGE);
    console.error(error.message);
    return 2;
  }
  let precheck;
  try {
    precheck = runChecker(options.root, spawn);
  } catch (error) {
    console.error(`Release precheck failed: ${error.message}; no files were written.`);
    return 1;
  }
  if (precheck.status !== 0) {
    process.stderr.write(precheck.stderr ?? "");
    process.stdout.write(precheck.stdout ?? "");
    console.error(`Release precheck failed for ${options.root}; no files were written.`);
    return 1;
  }
  let plan;
  try {
    plan = planEdits(options.root, options.version);
  } catch (error) {
    console.error(`Cannot prepare the release bump: ${error.message}; no files were written.`);
    return 1;
  }
  if (plan.current === options.version) {
    console.error(`Target version ${options.version} is already the current version; no files were written.`);
    return 1;
  }
  let written;
  try {
    written = applyEdits(options.root, plan.edits, hooks);
  } catch (error) {
    console.error(`Release bump failed: ${error.message}`);
    return 1;
  }
  let postcheck;
  try {
    postcheck = runChecker(options.root, spawn);
  } catch (error) {
    const failures = restoreEdits(options.root, written, {
      writeFile: hooks.writeFile ?? fs.writeFileSync,
      rename: hooks.rename ?? fs.renameSync,
    });
    console.error(`Post-write verification could not run: ${error.message}`);
    console.error(failures.length > 0 ? `Rollback failed for ${failures.join(", ")}` : "Restored every changed file.");
    return 1;
  }
  if (postcheck.status !== 0) {
    process.stderr.write(postcheck.stderr ?? "");
    process.stdout.write(postcheck.stdout ?? "");
    const failures = restoreEdits(options.root, written, {
      writeFile: hooks.writeFile ?? fs.writeFileSync,
      rename: hooks.rename ?? fs.renameSync,
    });
    console.error("Post-write verification failed.");
    console.error(failures.length > 0 ? `Rollback failed for ${failures.join(", ")}` : "Restored every changed file.");
    return 1;
  }
  console.log(`Bumped ${plan.current} -> ${options.version} across ${plan.declarations} version declarations in ${written.length} files.`);
  for (const edit of written) console.log(`- ${edit.relative}`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = run(process.argv.slice(2));
}
