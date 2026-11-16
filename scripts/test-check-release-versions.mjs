import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "check-release-versions.mjs");
const name = "@sencha930511/pi-model-sync";
const version = "1.2.3";
const changelog = `# Changelog\n\n## ${version} — 2026-11-16\n\n- Fixture release.\n`;

function writeText(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function writeJson(root, relative, value) {
  writeText(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function updateJson(root, relative, update) {
  const file = path.join(root, relative);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  update(value);
  writeJson(root, relative, value);
}

function readmeText(v) {
  return [
    "# pi-model-sync",
    "",
    "```sh",
    `omp plugin install git:github.com/SenCha930511/pi-model-sync@v${v}`,
    `pi install git:github.com/SenCha930511/pi-model-sync@v${v}`,
    "```",
    "",
  ].join("\n");
}

function llmsText(v) {
  return [
    "# pi-model-sync",
    "",
    `- git, tag-pinned (either host): \`omp plugin install git:github.com/SenCha930511/pi-model-sync@v${v}\` / \`pi install git:github.com/SenCha930511/pi-model-sync@v${v}\``,
    "",
  ].join("\n");
}

function agentsText(v) {
  return `# Repository Guidelines\n\nMIT license, v${v}, published to npm as \`@sencha930511/pi-model-sync\`.\n`;
}

function writeFixture(root) {
  writeJson(root, "package.json", { name, version });
  writeText(root, "README.md", readmeText(version));
  writeText(root, "llms.txt", llmsText(version));
  writeText(root, "AGENTS.md", agentsText(version));
}

function fixture(t, changelogText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-version-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFixture(root);
  if (changelogText !== undefined) writeText(root, "CHANGELOG.md", changelogText);
  return root;
}

function invoke(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  return result;
}

function check(root, ...args) {
  return invoke(["--root", root, ...args]);
}

function outcome(result, status) {
  assert.equal(result.status, status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function snapshot(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.push([path.relative(root, file), fs.readFileSync(file).toString("base64")]);
    }
  }
  visit(root);
  return files;
}

test("all six declarations and CRLF release metadata pass repeatedly without writes", (t) => {
  const root = fixture(t, changelog.replaceAll("\n", "\r\n"));
  const before = snapshot(root);
  outcome(check(root), 0);
  const args = ["--root", root, "--release", "--tag", `v${version}`];
  const first = invoke(args);
  outcome(first, 0);
  const second = invoke(args);
  outcome(second, 0);
  assert.deepEqual(
    { status: second.status, stdout: second.stdout, stderr: second.stderr },
    { status: first.status, stdout: first.stdout, stderr: first.stderr },
  );
  assert.deepEqual(snapshot(root), before);
});

test("a mismatch in every tracked source identifies that source", (t) => {
  const root = fixture(t);
  const cases = [
    ["package.json version", (value) => updateJson(root, "package.json", (json) => { json.version = value; })],
    ["README.md git tag pin #1", (value) => writeText(root, "README.md", readmeText(version).replace(`omp plugin install git:github.com/SenCha930511/pi-model-sync@v${version}`, `omp plugin install git:github.com/SenCha930511/pi-model-sync@v${value}`))],
    ["README.md git tag pin #2", (value) => writeText(root, "README.md", readmeText(version).replace(`pi install git:github.com/SenCha930511/pi-model-sync@v${version}`, `pi install git:github.com/SenCha930511/pi-model-sync@v${value}`))],
    ["llms.txt git tag pin #1", (value) => writeText(root, "llms.txt", llmsText(version).replace(`omp plugin install git:github.com/SenCha930511/pi-model-sync@v${version}`, `omp plugin install git:github.com/SenCha930511/pi-model-sync@v${value}`))],
    ["llms.txt git tag pin #2", (value) => writeText(root, "llms.txt", llmsText(version).replace(`pi install git:github.com/SenCha930511/pi-model-sync@v${version}`, `pi install git:github.com/SenCha930511/pi-model-sync@v${value}`))],
    ["AGENTS.md overview version", (value) => writeText(root, "AGENTS.md", agentsText(value))],
  ];
  for (const [source, mutate] of cases) {
    writeFixture(root);
    mutate("9.8.7");
    assert.match(outcome(check(root), 1).stderr, new RegExp(source.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("invalid authoritative versions and package name mismatch fail", (t) => {
  const root = fixture(t);
  for (const invalid of ["", 10203, null, "1.2", "v1.2.3", "01.2.3", "1.2.3-alpha", "1.2.3+build"]) {
    updateJson(root, "package.json", (json) => { json.version = invalid; });
    assert.match(outcome(check(root, "--release", "--tag", "v9.9.9"), 1).stderr, /package\.json version/);
  }
  writeFixture(root);
  updateJson(root, "package.json", (json) => { json.name = "wrong-package"; });
  assert.match(outcome(check(root), 1).stderr, /package\.json name/);
});

test("missing or extra tag pins in docs fail", (t) => {
  const root = fixture(t);
  writeText(root, "README.md", "# pi-model-sync\n");
  assert.match(outcome(check(root), 1).stderr, /README\.md git tag pin: expected 2/);
  writeFixture(root);
  writeText(root, "llms.txt", "# pi-model-sync\n");
  assert.match(outcome(check(root), 1).stderr, /llms\.txt git tag pin: expected 2/);
  writeFixture(root);
  writeText(root, "AGENTS.md", "# Repository Guidelines\n");
  assert.match(outcome(check(root), 1).stderr, /AGENTS\.md overview version: expected 1/);
});

test("release validates changelog heading, calendar date, and duplicates", (t) => {
  const withoutChangelog = fixture(t);
  outcome(check(withoutChangelog), 0);
  assert.match(outcome(check(withoutChangelog, "--release", "--tag", `v${version}`), 1).stderr, /CHANGELOG\.md/);
  const draft = fixture(t, "# Changelog\n\n## Unreleased\n");
  assert.match(outcome(check(draft, "--release", "--tag", `v${version}`), 1).stderr, /first ## heading/);
  const wrongFirst = fixture(t, `# Changelog\n\n## 9.9.9 — 2026-11-16\n\n- Other.\n\n## ${version} — 2026-11-16\n\n- Target.\n`);
  assert.match(outcome(check(wrongFirst, "--release", "--tag", `v${version}`), 1).stderr, /first ## heading/);
  const dup = fixture(t, `${changelog}\n## ${version} — 2026-11-15\n\n- Duplicate.\n`);
  assert.match(outcome(check(dup, "--release", "--tag", `v${version}`), 1).stderr, /duplicate heading/);
  const empty = fixture(t, `# Changelog\n\n## ${version} — 2026-11-16\n\n   \n\n## 1.2.2 — 2026-11-15\n\n- Older.\n`);
  assert.match(outcome(check(empty, "--release", "--tag", `v${version}`), 1).stderr, /must not be empty/);
  const badDate = fixture(t, changelog.replace("2026-11-16", "2026-99-99"));
  assert.match(outcome(check(badDate, "--release", "--tag", `v${version}`), 1).stderr, /YYYY-MM-DD/);
  const badHeader = fixture(t, "Not a changelog\n");
  assert.match(outcome(check(badHeader, "--release", "--tag", `v${version}`), 1).stderr, /must start with # Changelog/);
});

test("hidden changelog headings cannot replace the visible release heading", (t) => {
  for (const hiddenText of [
    `# Changelog\n\n<!--\n## ${version} — 2026-11-16\n-->\n\n## 9.9.9 — 2026-11-16\n`,
    `# Changelog\n\n\`\`\`markdown\n## ${version} — 2026-11-16\n\`\`\`\n\n## 9.9.9 — 2026-11-16\n`,
  ]) {
    const root = fixture(t, hiddenText);
    assert.match(outcome(check(root, "--release", "--tag", `v${version}`), 1).stderr, /first ## heading/);
  }
  const root = fixture(t, `${changelog}\n\`\`\`markdown\n## ${version} — 2026-11-15\n\`\`\`\n<!--\n## ${version} — 2026-11-15\n-->\n`);
  outcome(check(root, "--release", "--tag", `v${version}`), 0);
});

test("wrong, unprefixed, and prerelease tags fail release content checks", (t) => {
  const root = fixture(t, changelog);
  for (const tag of ["v9.9.9", version, `v${version}-alpha`]) {
    assert.match(outcome(check(root, "--release", "--tag", tag), 1).stderr, /release tag/);
  }
});

test("argument boundaries are usage errors", (t) => {
  const root = fixture(t);
  const cases = [
    ["--root", root, "--release"],
    ["--root", root, "--tag", `v${version}`],
    ["--root", root, "--notes-output", path.join(root, "notes.md")],
    ["--root", root, "--release", "--tag"],
    ["--root", root, "--release", "--tag", ""],
    ["--root", root, "--release", "--tag", `v${version}`, "--notes-output"],
    ["--root", root, "--release", "--tag", `v${version}`, "--notes-output", "--root"],
    ["--root", root, "--release", "--tag", `v${version}`, "--notes-output", path.join(root, "a.md"), "--notes-output", path.join(root, "b.md")],
    ["--root", root, "--release", "--release", "--tag", `v${version}`],
    ["--root", root, "--tag", `v${version}`, "--tag", `v${version}`, "--release"],
    ["--root", root, "--root", root],
    ["--root"],
    ["--root", root, "--unknown"],
  ];
  for (const args of cases) assert.match(outcome(invoke(args), 2).stderr, /Usage:/);
});

test("notes-output writes trimmed release notes only when all checks pass", (t) => {
  const sectionBody = [
    "- First change.",
    "",
    "```markdown",
    "## 0.0.0 — 2026-01-01",
    "code fence content",
    "```",
    "",
    "### Details",
    "",
    "- Second change.",
  ].join("\n");
  const fullChangelog = `# Changelog\n\n## ${version} — 2026-11-16\n\n\n${sectionBody}\n\n\n## 1.2.2 — 2026-11-15\n\n- Older release.\n`;
  const root = fixture(t, fullChangelog);
  const notesFile = path.join(root, "out", "release-notes.md");

  outcome(check(root, "--release", "--tag", `v${version}`, "--notes-output", notesFile), 0);
  assert.equal(fs.readFileSync(notesFile, "utf8"), `${sectionBody}\n`);

  const failedNotesFile = path.join(root, "out", "failed-notes.md");
  outcome(check(root, "--release", "--tag", "v9.9.9", "--notes-output", failedNotesFile), 1);
  assert.equal(fs.existsSync(failedNotesFile), false);
});
