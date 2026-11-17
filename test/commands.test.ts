import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  getGlobalConfigPath,
  getProjectConfigPath,
  isNamedConfig,
  getPresetProfiles,
  presetNames,
  projectActiveProfiles,
  readLayer,
  writeConfig,
} from "../config";
import type { ModelSyncConfig } from "../config";
import { createHostHarness, makeTempDir, useIsolatedConfig } from "./harness";

useIsolatedConfig();

function writeGlobal(cwd: string, config: ModelSyncConfig): string {
  const target = getGlobalConfigPath(cwd);
  writeConfig(target, config);
  return target;
}

function readGlobal(cwd: string): ModelSyncConfig {
  return readLayer(getGlobalConfigPath(cwd)).config;
}

function modelCtx(cwd: string, extra: Record<string, unknown> = {}) {
  return {
    cwd,
    models: {
      current: () => ({ provider: "openai", id: "gpt-6" }),
      resolve: () => true,
    },
    ...extra,
  };
}

const AGENT_SCHEMA = {
  name: "Agent",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      subagent_type: { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
    },
  },
};

describe("command parsing", () => {
  test("keeps quoted arguments together and rejects unbalanced quotes", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const unbalanced = await host.runCommand('preset create "focus', modelCtx(cwd));
    expect(unbalanced[0]?.level).toBe("warning");
    expect(unbalanced[0]?.message).toContain("Unbalanced quotes");
  });

  test("rejects unknown flags instead of writing them as names", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const unknown = await host.runCommand("add --global foo bar", modelCtx(cwd));
    expect(unknown[0]?.level).toBe("warning");
    expect(unknown[0]?.message).toContain('Unknown option "--global"');
    expect(readLayer(getGlobalConfigPath(cwd)).exists).toBe(false);

    const help = await host.runCommand("preset create --help", modelCtx(cwd));
    expect(help[0]?.message).toContain("pi-model-sync preset commands");
    expect(readLayer(getGlobalConfigPath(cwd)).exists).toBe(false);
  });

  test("targets the project layer and preserves a quoted literal flag", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    await host.runCommand("add --project openai/gpt-6 openai/mini", modelCtx(cwd));
    expect(readLayer(getProjectConfigPath(cwd)).exists).toBe(true);
    expect(readLayer(getGlobalConfigPath(cwd)).exists).toBe(false);

    await host.runCommand('preset create "--help"', modelCtx(cwd));
    const presets = presetNames(readGlobal(cwd));
    expect(presets).toContain("--help");
  });
});

describe("profile commands", () => {
  test("add, set, remove, and move preserve the documented shapes", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);

    await host.runCommand("add openai/gpt-6 openai/mini", ctx);
    await host.runCommand("set openai/gpt-6 explore openai/scout", ctx);
    await host.runCommand("set openai/gpt-6 * openai/luna", ctx);
    let profiles = projectActiveProfiles(readGlobal(cwd)).profiles;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.subagents).toEqual({ "*": "openai/luna", explore: "openai/scout" });

    await host.runCommand("remove openai/gpt-6 explore", ctx);
    profiles = projectActiveProfiles(readGlobal(cwd)).profiles;
    expect(profiles[0]?.subagents).toBe("openai/luna");

    await host.runCommand("remove openai/gpt-6", ctx);
    expect(projectActiveProfiles(readGlobal(cwd)).profiles).toHaveLength(0);
  });

  test("updates the profile main case in set and warns before replacing agent entries", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);
    await host.runCommand("add OpenAI/GPT-6 openai/mini", ctx);
    await host.runCommand("set openai/gpt-6 explore openai/scout", ctx);
    await host.runCommand("set openai/gpt-6 * openai/luna", ctx);

    const replaced = await host.runCommand("add openai/gpt-6 openai/other", ctx);
    expect(replaced[0]?.message).toContain("replaced the existing per-agent entries");
    const profiles = projectActiveProfiles(readGlobal(cwd)).profiles;
    expect(profiles[0]?.main).toBe("openai/gpt-6");
    expect(profiles[0]?.subagents).toBe("openai/other");
  });

  test("warns when an earlier wildcard shadows a new literal profile", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);
    await host.runCommand("add * openai/fallback", ctx);
    const shadowed = await host.runCommand("add openai/gpt-6 openai/mini", ctx);
    expect(shadowed[0]?.message).toContain("appears earlier and may match this model first");
  });

  test("remove reports a missing agent and refuses to remove from a string profile", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);
    await host.runCommand("add openai/gpt-6 openai/mini", ctx);
    const single = await host.runCommand("remove openai/gpt-6 explore", ctx);
    expect(single[0]?.level).toBe("warning");
    expect(single[0]?.message).toContain("single default model");

    await host.runCommand("set openai/gpt-6 explore openai/scout", ctx);
    const missing = await host.runCommand("remove openai/gpt-6 missing", ctx);
    expect(missing[0]?.level).toBe("warning");
    expect(missing[0]?.message).toContain('no entry for agent "missing"');
  });

  test("remove rejects a blank agent argument instead of deleting the profile", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);
    await host.runCommand("add openai/gpt-6 openai/mini", ctx);
    const blank = await host.runCommand('remove openai/gpt-6 ""', ctx);
    expect(blank[0]?.level).toBe("warning");
    expect(blank[0]?.message).toContain("Usage: /model-sync remove <main> [agent]");
    expect(projectActiveProfiles(readGlobal(cwd)).profiles).toHaveLength(1);
  });

  test("set * collapses a default-only map back to the plain string form", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);
    writeGlobal(cwd, { profiles: [{ main: "openai/gpt-6", subagents: { "*": "openai/old" } }] });
    await host.runCommand("set openai/gpt-6 * openai/luna", ctx);
    expect(projectActiveProfiles(readGlobal(cwd)).profiles[0]?.subagents).toBe("openai/luna");

    writeGlobal(cwd, { profiles: [{ main: "openai/gpt-6", subagents: { "*": "openai/old", scout: "openai/scout" } }] });
    await host.runCommand("set openai/gpt-6 * openai/luna", ctx);
    expect(projectActiveProfiles(readGlobal(cwd)).profiles[0]?.subagents).toEqual({
      "*": "openai/luna",
      scout: "openai/scout",
    });
  });

  test("move handles bottom, down, edges, single profiles, and invalid positions", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);
    await host.runCommand("add openai/gpt-6 openai/mini", ctx);
    const single = await host.runCommand("move openai/gpt-6 top", ctx);
    expect(single[0]?.level).toBe("warning");
    expect(single[0]?.message).toContain("already at the top");

    await host.runCommand("add anthropic/* anthropic/haiku", ctx);
    const bottom = await host.runCommand("move openai/gpt-6 bottom", ctx);
    expect(bottom[0]?.message).toContain("position 2 of 2");
    const down = await host.runCommand("move openai/gpt-6 down", ctx);
    expect(down[0]?.level).toBe("warning");
    expect(down[0]?.message).toContain("already at the bottom");
    const bottomAgain = await host.runCommand("move openai/gpt-6 bottom", ctx);
    expect(bottomAgain[0]?.level).toBe("warning");
    expect(bottomAgain[0]?.message).toContain("already at the bottom");

    const invalid = await host.runCommand("move openai/gpt-6 sideways", ctx);
    expect(invalid[0]?.level).toBe("warning");
    const missing = await host.runCommand("move missing/model top", ctx);
    expect(missing[0]?.level).toBe("warning");
    expect(missing[0]?.message).toContain("No profile found");
  });

  test("show strips :level, reports plugin dialect compatibility, and handles misses", async () => {
    const host = createHostHarness({ tools: [AGENT_SCHEMA] });
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      profiles: [{ main: "openai/gpt-6", subagents: { "*": "@smol", explore: "openai/mini:high" } }],
    });
    const ctx = modelCtx(cwd);
    const show = await host.runCommand("show openai/gpt-6:high explore", ctx);
    expect(show[0]?.message).toContain("Matched profile: main=openai/gpt-6");
    expect(show[0]?.message).toContain("explore → openai/mini:high");
    expect(show[0]?.message).toContain("plugins: tintinweb");

    const alias = await host.runCommand("show openai/gpt-6", ctx);
    expect(alias[0]?.message).toContain("no installed plugin accepts this selector");

    const miss = await host.runCommand("show anthropic/claude-4", ctx);
    expect(miss[0]?.message).toContain("No matching profile");

    const invalid = await host.runCommand("show @smol", ctx);
    expect(invalid[0]?.level).toBe("warning");
  });

  test("show matches a slash-containing bare id and reports case-insensitive matching", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      profiles: [
        {
          main: "meta-llama/Llama-3.3-70B-Instruct",
          subagents: { Explore: "together/meta-llama/Llama-3.3-70B-Instruct" },
          agentMatch: "case-insensitive",
        },
      ],
    });
    const ctx = modelCtx(cwd);
    const shown = await host.runCommand("show meta-llama/Llama-3.3-70B-Instruct:high explore", ctx);
    expect(shown[0]?.message).toContain("Matched profile");
    expect(shown[0]?.message).toContain("Agent matching: case-insensitive");
    expect(shown[0]?.message).toContain("explore → together/meta-llama/Llama-3.3-70B-Instruct");
  });

  test("show uses the requested model's provider for plugin checks", async () => {
    const nicobailon = {
      name: "subagent",
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          ["agent", "task", "workflow", "action", "options", "model"].map((prop) => [prop, { type: "string" }]),
        ),
      },
    };
    const host = createHostHarness({ tools: [nicobailon] });
    const cwd = makeTempDir();
    writeGlobal(cwd, { profiles: [{ main: "openai/gpt-6", subagents: { scout: "gpt-x" } }] });
    const ctx = {
      cwd,
      model: { provider: "google", id: "gpt-6" },
      modelRegistry: {
        getAvailable: () => [
          { provider: "openai", id: "gpt-x" },
          { provider: "anthropic", id: "gpt-x" },
        ],
      },
    };
    const shown = await host.runCommand("show openai/gpt-6", ctx);
    expect(shown[0]?.message).toContain("plugins: nicobailon");
  });

  test("list reports the inactive layer and a broken active file", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, { profiles: [{ main: "*", subagents: "openai/fallback" }] });
    const project = getProjectConfigPath(cwd);
    mkdirSync(path.dirname(project), { recursive: true });
    writeFileSync(project, "{ broken json");
    const listed = await host.runCommand("list", modelCtx(cwd));
    expect(listed[0]?.message).toContain("(inactive) global layer");
    expect(listed[0]?.message).toContain("Could not parse config file");
    expect(listed[0]?.message).toContain("No profiles are active because the active config has an error.");
  });
});

describe("preset commands", () => {
  test("creates, copies, renames, uses, and removes presets with the documented guards", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);
    await host.runCommand("add openai/gpt-6 openai/mini", ctx);

    const create = await host.runCommand("preset create focus", ctx);
    expect(create[0]?.message).toContain('Legacy profiles moved to preset "default"');
    expect(presetNames(readGlobal(cwd))).toEqual(["default", "focus"]);

    const duplicate = await host.runCommand("preset create focus", ctx);
    expect(duplicate[0]?.level).toBe("warning");
    const invalid = await host.runCommand('preset create "bad name"', ctx);
    expect(invalid[0]?.level).toBe("warning");

    await host.runCommand("preset copy default backup", ctx);

    await host.runCommand("preset use backup", ctx);
    await host.runCommand("add anthropic/claude-4 anthropic/haiku", ctx);
    const isolated = readGlobal(cwd);
    expect(getPresetProfiles(isolated, "default")).toEqual([
      { main: "openai/gpt-6", subagents: "openai/mini" },
    ]);
    expect(getPresetProfiles(isolated, "backup")?.map((profile) => profile.main)).toEqual([
      "openai/gpt-6",
      "anthropic/claude-4",
    ]);
    await host.runCommand("preset use default", ctx);
    const copyExisting = await host.runCommand("preset copy default backup", ctx);
    expect(copyExisting[0]?.level).toBe("warning");
    const copyMissing = await host.runCommand("preset copy missing other", ctx);
    expect(copyMissing[0]?.level).toBe("warning");

    await host.runCommand("preset rename backup archive", ctx);
    const renameMissing = await host.runCommand("preset rename missing other", ctx);
    expect(renameMissing[0]?.level).toBe("warning");
    const renameExisting = await host.runCommand("preset rename archive default", ctx);
    expect(renameExisting[0]?.level).toBe("warning");
    const renameSame = await host.runCommand("preset rename archive archive", ctx);
    expect(renameSame[0]?.message).toContain("already named that");

    const useMissing = await host.runCommand("preset use missing", ctx);
    expect(useMissing[0]?.level).toBe("warning");
    const useInvalid = await host.runCommand('preset use "bad name"', ctx);
    expect(useInvalid[0]?.level).toBe("warning");
    const useFocus = await host.runCommand("preset use focus", ctx);
    expect(useFocus[0]?.message).toContain("Active preset: focus");

    const removeActive = await host.runCommand("preset remove focus", ctx);
    expect(removeActive[0]?.level).toBe("warning");
    const removeMissing = await host.runCommand("preset remove missing", ctx);
    expect(removeMissing[0]?.level).toBe("warning");
    await host.runCommand("preset remove archive", ctx);
    expect(presetNames(readGlobal(cwd))).toEqual(["default", "focus"]);
  });

  test("legacy preset guards cover default create/copy/rename/remove and list", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);
    await host.runCommand("add openai/gpt-6 openai/mini", ctx);

    const createDefault = await host.runCommand("preset create default", ctx);
    expect(createDefault[0]?.level).toBe("warning");
    const copyDefault = await host.runCommand("preset copy default default", ctx);
    expect(copyDefault[0]?.level).toBe("warning");
    const copyMissing = await host.runCommand("preset copy other target", ctx);
    expect(copyMissing[0]?.level).toBe("warning");
    const renameSame = await host.runCommand("preset rename default default", ctx);
    expect(renameSame[0]?.message).toContain("already named that");
    const renameMissing = await host.runCommand("preset rename other target", ctx);
    expect(renameMissing[0]?.level).toBe("warning");
    const useDefault = await host.runCommand("preset use default", ctx);
    expect(useDefault[0]?.message).toContain("already active");
    const removeDefault = await host.runCommand("preset remove default", ctx);
    expect(removeDefault[0]?.level).toBe("warning");
    const listed = await host.runCommand("preset list", ctx);
    expect(listed[0]?.message).toContain("default (legacy)");
  });

  test("renames the legacy default preset and keeps it active", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);
    await host.runCommand("add openai/gpt-6 openai/mini", ctx);
    await host.runCommand("preset rename default daily", ctx);
    const config = readGlobal(cwd);
    expect(isNamedConfig(config)).toBe(true);
    if (!isNamedConfig(config)) return;
    expect(config.activePreset).toBe("daily");
    expect(config.presets.daily).toHaveLength(1);
  });

  test("preset use without a name is interactive when the host has a UI", async () => {
    const host = createHostHarness({ hasUI: true, select: async () => "focus" });
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);
    await host.runCommand("preset create focus", ctx);
    await host.runCommand("preset use", ctx);
    const config = readGlobal(cwd);
    expect(isNamedConfig(config)).toBe(true);
    if (isNamedConfig(config)) expect(config.activePreset).toBe("focus");

    const noUi = createHostHarness();
    const usage = await noUi.runCommand("preset use", modelCtx(cwd));
    expect(usage[0]?.level).toBe("warning");
  });

  test("preset list reports a session override without changing the on-disk active preset", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);
    await host.runCommand("preset create focus", ctx);
    await host.runCommand("use-session focus", ctx);
    const listed = await host.runCommand("preset list", ctx);
    expect(listed[0]?.message).toContain("Session preset: focus (not saved)");
    expect(listed[0]?.message).toContain("* default");
  });
});

describe("usage guards", () => {
  test("rejects malformed arity and unknown actions", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, { profiles: [] });
    const ctx = modelCtx(cwd);
    const cases = [
      "list extra",
      "show a b c",
      "add only-main",
      "set main agent",
      "remove",
      "move main",
      "preset list extra",
      "preset create",
      "preset copy source",
      "preset rename old",
      "preset use one two",
      "preset remove",
      "preset help extra",
      "preset unknown",
      "status on",
      "use-session",
      "pause extra",
      "resume extra",
      "log extra",
      "doctor extra",
      "init extra",
      "help extra",
    ];
    for (const args of cases) {
      const result = await host.runCommand(args, ctx);
      expect({ args, level: result[0]?.level }).toEqual({ args, level: "warning" });
    }
    const presetUsage = await host.runCommand("preset", ctx);
    expect(presetUsage[0]?.message).toContain("preset commands");
  });
});
