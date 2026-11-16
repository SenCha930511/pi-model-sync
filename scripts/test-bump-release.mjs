import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyEdits, planEdits, run } from "./bump-release.mjs";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "bump-release.mjs");
const checker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "check-release-versions.mjs");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const name = "@sencha930511/pi-model-sync";
const current = "1.2.3";
const target = "2.3.4";
const fixtureFiles = ["package.json", "README.md", "llms.txt", "AGENTS.md"];
const projectBefore = new Map(fixtureFiles.map((relative) => [
  relative,
  fs.readFileSync(path.join(projectRoot, relative)).toString("base64"),
]));

function fixtureText(relative, version) {
  switch (relative) {
    case "package.json":
      return `{\r\n  "name": "${name}",\r\n  "version": "${version}",\r\n  "nested": {\r\n    "version": "0.0.9"\r\n  }\r\n}\r\n`;
    case "README.md":
      return `# pi-model-sync\n\n\`\`\`sh\nomp plugin install git:github.com/SenCha930511/pi-model-sync@v${version}\npi install git:github.com/SenCha930511/pi-model-sync@v${version}\n\`\`\`\n`;
    case "llms.txt":
      return `# pi-model-sync\n\n- git: \`omp plugin install git:github.com/SenCha930511/pi-model-sync@v${version}\` / \`pi install git:github.com/SenCha930511/pi-model-sync@v${version}\`\n`;
    case "AGENTS.md":
      return `# Repository Guidelines\n\nMIT license, v${version}, published to npm as \`@sencha930511/pi-model-sync\`.\n`;
    default:
      throw new Error(`unknown fixture: ${relative}`);
  }
}

function writeText(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function readText(root, relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function writeFixture(root) {
  for (const relative of fixtureFiles) writeText(root, relative, fixtureText(relative, current));
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "release-bump-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "fixture root");
  fs.mkdirSync(root);
  writeFixture(root);
  return root;
}

function invoke(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function bump(root, version) {
  return invoke([version, "--root", root]);
}

function check(root) {
  const result = spawnSync(process.execPath, [checker, "--root", root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function outcome(result, status) {
  assert.equal(result.status, status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function snapshot(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.push([path.relative(root, file), fs.readFileSync(file).toString("base64")]);
    }
  }
  visit(root);
  return files;
}

test("bumps six declarations in a path with spaces and preserves every other byte", (t) => {
  const root = fixture(t);
  assert.match(root, / /);
  const before = snapshot(root);
  const result = outcome(bump(root, target), 0);
  assert.match(result.stdout, /Bumped 1\.2\.3 -> 2\.3\.4 across 6 version declarations in 4 files/);
  for (const relative of fixtureFiles) {
    assert.equal(readText(root, relative), fixtureText(relative, target), relative);
  }
  assert.ok(readText(root, "package.json").includes(`"version": "${target}",\r\n`));
  assert.notDeepEqual(snapshot(root), before);
  outcome(check(root), 0);
});

test("repeated runs are deterministic and reject the version they already applied", (t) => {
  const root = fixture(t);
  outcome(bump(root, target), 0);
  const first = snapshot(root);
  const repeated = outcome(bump(root, target), 1);
  assert.match(repeated.stderr, /already the current version/);
  assert.deepEqual(snapshot(root), first);
  outcome(bump(root, "2.3.5"), 0);
  outcome(check(root), 0);
  assert.match(readText(root, "package.json"), /"version": "2\.3\.5"/);
  assert.match(outcome(bump(root, "2.3.5"), 1).stderr, /already the current version/);
});

test("an equal target version is rejected before writes", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const result = outcome(bump(root, current), 1);
  assert.match(result.stderr, /already the current version/);
  assert.deepEqual(snapshot(root), before);
});

test("a drifted tree is rejected before writes", (t) => {
  const root = fixture(t);
  writeText(root, "AGENTS.md", fixtureText("AGENTS.md", "9.8.7"));
  const before = snapshot(root);
  const result = outcome(bump(root, target), 1);
  assert.match(result.stderr, /Release precheck failed/);
  assert.match(result.stderr, /AGENTS\.md overview version/);
  assert.deepEqual(snapshot(root), before);
});

test("invalid targets and argument boundaries are usage errors without writes", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const cases = [
    [],
    ["--root", root],
    [current, "--root"],
    [current, "--root", ""],
    [current, "--root", root, "--root", root],
    [current, "--root", root, "extra"],
    [current, "--unknown"],
    ["", "--root", root],
    ["1.2", "--root", root],
    ["v1.2.3", "--root", root],
    ["01.2.3", "--root", root],
    ["1.2.3-alpha", "--root", root],
    ["1.2.3+build", "--root", root],
  ];
  for (const args of cases) {
    const result = outcome(invoke(args), 2);
    assert.match(result.stderr, /Usage:/, JSON.stringify(args));
  }
  assert.deepEqual(snapshot(root), before);
});

test("a write failure restores every file changed by that invocation", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  const plan = planEdits(root, target);
  assert.equal(plan.declarations, 6);
  let failed = false;
  assert.throws(() => applyEdits(root, plan.edits, {
    writeFile(file, bytes, options) {
      if (!failed && path.basename(file).startsWith("AGENTS.md.bump-")) {
        failed = true;
        throw new Error("simulated disk failure");
      }
      fs.writeFileSync(file, bytes, options);
    },
  }), /simulated disk failure; all changed files were restored/);
  assert.equal(failed, true);
  assert.deepEqual(snapshot(root), before);
});

test("post-write verification failure restores every file", (t) => {
  const root = fixture(t);
  const before = snapshot(root);
  let calls = 0;
  const status = run([target, "--root", root], {
    spawn(command, args) {
      calls += 1;
      assert.equal(command, process.execPath);
      assert.equal(args[0], checker);
      assert.deepEqual(args.slice(1), ["--root", root]);
      return calls === 1
        ? { status: 0, stdout: "", stderr: "" }
        : { status: 1, stdout: "", stderr: "simulated postcheck failure\n" };
    },
  });
  assert.equal(status, 1);
  assert.equal(calls, 2);
  assert.deepEqual(snapshot(root), before);
});

test("fixture runs never mutate the project release metadata", () => {
  for (const relative of fixtureFiles) {
    assert.equal(
      fs.readFileSync(path.join(projectRoot, relative)).toString("base64"),
      projectBefore.get(relative),
      relative,
    );
  }
});
