import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectActiveProfiles, readConfig, readLayer, resolveActiveLayer, writeConfig } from "../config";

const tempRoots: string[] = [];
const readonlyDirs: string[] = [];
const savedEnv = {
  PI_MODEL_SYNC_CONFIG: process.env.PI_MODEL_SYNC_CONFIG,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

function makeTempDir(prefix = "pi-model-sync-posix-"): string {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), prefix));
  tempRoots.push(dir);
  return dir;
}

beforeEach(() => {
  const isolatedAgent = makeTempDir("isolated-agent-");
  delete process.env.PI_MODEL_SYNC_CONFIG;
  process.env.PI_CODING_AGENT_DIR = path.join(isolatedAgent, "agent");
});

afterEach(() => {
  for (const dir of readonlyDirs.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {}
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("POSIX filesystem invariants", () => {
  test("directory at config path is ignored as non-file", () => {
    const cwd = makeTempDir("cwd-");
    const dirAtProjectConfig = path.join(cwd, ".omp", "pi-model-sync.json");
    mkdirSync(dirAtProjectConfig, { recursive: true });
    expect(resolveActiveLayer(cwd).layer).toBe("global");
    expect(readLayer(dirAtProjectConfig).exists).toBe(false);
    expect(readConfig(cwd).profiles).toEqual([]);
  });

  test("writeConfig cleans up temporary file when target directory is read-only", () => {
    if (process.getuid?.() === 0) return;
    const dir = makeTempDir("ro-");
    const target = path.join(dir, "pi-model-sync.json");
    chmodSync(dir, 0o555);
    readonlyDirs.push(dir);

    expect(() => writeConfig(target, { profiles: [{ main: "a", subagents: "b" }] })).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("writeConfig follows a symlink instead of replacing it", () => {
    const dir = makeTempDir("symlink-");
    const real = path.join(dir, "real.json");
    const link = path.join(dir, "link.json");
    writeConfig(real, { profiles: [] });
    symlinkSync(real, link);
    writeConfig(link, { profiles: [{ main: "*", subagents: "openai/mini" }] });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(projectActiveProfiles(readLayer(real).config).profiles).toHaveLength(1);
  });
});
