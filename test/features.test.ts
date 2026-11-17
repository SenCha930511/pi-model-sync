import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  getGlobalConfigPath,
  getPresetProfiles,
  getProjectConfigPath,
  isNamedConfig,
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

const EDXETH_SCHEMA = {
  name: "subagent",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      task: { type: "string" },
      title: { type: "string" },
      children: { type: "array", items: { type: "object" } },
      model: { type: "string" },
      thinking: { type: "string" },
    },
  },
};

describe("session routing controls", () => {
  test("use-session routes in memory without rewriting the file", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const target = writeGlobal(cwd, {
      activePreset: "default",
      presets: {
        default: [{ main: "openai/gpt-6", subagents: { explore: "openai/mini" } }],
        focus: [{ main: "openai/gpt-6", subagents: { explore: "openai/focus" } }],
      },
    });
    const before = readFileSync(target, "utf8");
    const ctx = modelCtx(cwd);

    await host.runCommand("use-session focus", ctx);
    const focused = host.emitSpawn({ agent: "explore" }, ctx) as { model: string[] };
    expect(focused.model).toEqual(["openai/focus"]);
    expect(readFileSync(target, "utf8")).toBe(before);

    await host.runCommand("use-session off", ctx);
    const normal = host.emitSpawn({ agent: "explore" }, ctx) as { model: string[] };
    expect(normal.model).toEqual(["openai/mini"]);
  });

  test("use-session reads the active project layer", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      activePreset: "default",
      presets: {
        default: [{ main: "openai/gpt-6", subagents: { explore: "openai/global" } }],
      },
    });
    writeConfig(getProjectConfigPath(cwd), {
      activePreset: "default",
      presets: {
        default: [{ main: "openai/gpt-6", subagents: { explore: "openai/project" } }],
        focus: [{ main: "openai/gpt-6", subagents: { explore: "openai/focus" } }],
      },
    });
    const ctx = modelCtx(cwd);
    const selected = await host.runCommand("use-session focus", ctx);
    expect(selected[0]?.message).toContain("not saved");
    const routed = host.emitSpawn({ agent: "explore" }, ctx) as { model: string[] };
    expect(routed.model).toEqual(["openai/focus"]);
  });

  test("pause and resume gate routing, and status reports the session", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      profiles: [{ main: "openai/gpt-6", subagents: { explore: "openai/mini" } }],
    });
    const ctx = modelCtx(cwd);

    await host.runCommand("pause", ctx);
    expect(host.emitSpawn({ agent: "explore" }, ctx)).toBeUndefined();
    const paused = await host.runCommand("status", ctx);
    expect(paused[0]?.message).toContain("Routing: paused");
    expect(paused[0]?.message).toContain("Route log: 1 entries");

    await host.runCommand("resume", ctx);
    const resumed = host.emitSpawn({ agent: "explore" }, ctx) as { model: string[] };
    expect(resumed.model).toEqual(["openai/mini"]);
    const status = await host.runCommand("status", ctx);
    expect(status[0]?.message).toContain("Routing: active");
    expect(status[0]?.message).toContain("Matched profile: openai/gpt-6");
  });

  test("status bar updates on status, pause, resume, use-session, and off", async () => {
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const host = createHostHarness({
      setStatus: (key, text) => statuses.push({ key, text }),
    });
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      activePreset: "default",
      presets: {
        default: [{ main: "*", subagents: "openai/mini" }],
        focus: [{ main: "*", subagents: "openai/focus" }],
      },
    });
    const ctx = modelCtx(cwd);

    await host.runCommand("status", ctx);
    expect(statuses.at(-1)).toEqual({ key: "pi-model-sync", text: "active: default" });
    await host.runCommand("pause", ctx);
    expect(statuses.at(-1)?.text).toBe("paused");
    await host.runCommand("resume", ctx);
    expect(statuses.at(-1)?.text).toBe("active: default");
    await host.runCommand("use-session focus", ctx);
    expect(statuses.at(-1)?.text).toBe("session: focus");
    await host.runCommand("status off", ctx);
    expect(statuses.at(-1)?.text).toBeUndefined();
  });

  test("route log records routed and skipped decisions, then clears", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      profiles: [{ main: "openai/gpt-6", subagents: { "*": "openai/mini" } }],
    });
    const ctx = modelCtx(cwd);
    host.emitSpawn({ agent: "explore" }, ctx);
    await host.runCommand("pause", ctx);
    host.emitSpawn({ agent: "explore" }, ctx);

    const log = await host.runCommand("log", ctx);
    expect(log[0]?.message).toContain("spawn explore");
    expect(log[0]?.message).toContain("→ routed");
    expect(log[0]?.message).toContain("skipped: session paused");

    await host.runCommand("log clear", ctx);
    const empty = await host.runCommand("log", ctx);
    expect(empty[0]?.message).toContain("No routing decisions recorded");
  });

  test("warnings are per session instead of process-global", () => {
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      profiles: [{ main: "openai/gpt-6", subagents: { broken: "missing/selector" } }],
    });
    const warnings = (notifications: string[]) => ({
      cwd,
      mode: "tui",
      models: {
        current: () => ({ provider: "openai", id: "gpt-6" }),
        resolve: () => false,
      },
      ui: { notify: (message: string) => notifications.push(message) },
    });

    const first = createHostHarness();
    const firstWarnings: string[] = [];
    const firstCtx = warnings(firstWarnings);
    first.emitSpawn({ agent: "broken" }, firstCtx);
    first.emitSpawn({ agent: "broken" }, firstCtx);
    expect(firstWarnings).toHaveLength(1);

    const second = createHostHarness();
    const secondWarnings: string[] = [];
    second.emitSpawn({ agent: "broken" }, warnings(secondWarnings));
    expect(secondWarnings).toHaveLength(1);
  });
});

describe("doctor and init", () => {
  test("doctor reports shadowed rules, unknown keys, case-only agents, and plugin gaps", async () => {
    const host = createHostHarness({ tools: [AGENT_SCHEMA] });
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      profiles: [
        { main: "*", subagents: "@smol" },
        { main: "openai/gpt-6", subagents: { Explore: "openai/mini", explore: "openai/other" } },
      ],
    });
    const doctor = await host.runCommand("doctor", modelCtx(cwd));
    expect(doctor[0]?.message).toContain("shadowed by earlier profile");
    expect(doctor[0]?.message).toContain("differ only by case");
    expect(doctor[0]?.message).toContain("not accepted by any installed plugin");

    const unknownCwd = makeTempDir();
    writeFileSync(
      getGlobalConfigPath(unknownCwd),
      JSON.stringify({ presets: { default: [] }, active_preset: "default" }),
    );
    const unknown = await host.runCommand("doctor", modelCtx(unknownCwd));
    expect(unknown[0]?.message).toContain('Ignored unknown config key "active_preset"');
  });

  test("doctor reports a clean config", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, { profiles: [{ main: "*", subagents: "openai/mini" }] });
    const doctor = await host.runCommand("doctor", modelCtx(cwd));
    expect(doctor[0]?.message).toContain("No issues found.");
    expect(doctor[0]?.message).toContain("1 preset, 1 profile");
  });

  test("init creates a starter preset and refuses to overwrite", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    const ctx = modelCtx(cwd);
    await host.runCommand("init", ctx);
    const config = readGlobal(cwd);
    expect(isNamedConfig(config)).toBe(true);
    if (!isNamedConfig(config)) return;
    expect(config.activePreset).toBe("default");
    expect(config.presets.default?.[0]?.main).toBe("openai/gpt-6");

    const again = await host.runCommand("init", ctx);
    expect(again[0]?.message).toContain("Config already exists");

    const projectCwd = makeTempDir();
    writeConfig(getProjectConfigPath(projectCwd), { profiles: [] });
    const projectExisting = await host.runCommand("init", modelCtx(projectCwd));
    expect(projectExisting[0]?.message).toContain("Config already exists");

    const projectOnly = makeTempDir();
    const projectCreated = await host.runCommand("init --project", modelCtx(projectOnly));
    expect(projectCreated[0]?.message).toContain("Created starter config");
    expect(readLayer(getProjectConfigPath(projectOnly)).exists).toBe(true);

    const noModelCwd = makeTempDir();
    process.env.PI_MODEL_SYNC_CONFIG = "sync.json";
    const noModel = await host.runCommand("init", { cwd: noModelCwd });
    expect(noModel[0]?.level).toBe("warning");
    expect(noModel[0]?.message).toContain("Cannot determine the current model");
  });
});

describe("completion", () => {
  test("suggests models, agents, positions, session actions, and preserves --project", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      activePreset: "default",
      presets: {
        default: [{ main: "openai/gpt-6", subagents: { "*": "openai/luna", explore: "openai/mini" } }],
        focus: [],
      },
    });
    const ctx = modelCtx(cwd, {
      models: {
        current: () => ({ provider: "openai", id: "gpt-6" }),
        resolve: () => true,
        list: () => [
          { provider: "openai", id: "gpt-6" },
          { provider: "anthropic", id: "claude-haiku-4" },
        ],
      },
    });
    host.emitSessionStart(ctx);
    const complete = host.command().getArgumentCompletions!;

    expect(complete("")?.some((item) => item.label === "doctor")).toBe(true);
    expect(complete("")?.some((item) => item.label === "use-session")).toBe(true);
    expect(complete("add ")?.some((item) => item.label === "openai/gpt-6")).toBe(true);
    expect(complete("show ")?.some((item) => item.label === "anthropic/claude-haiku-4")).toBe(true);
    expect(complete("set openai/gpt-6 ")?.some((item) => item.label === "explore")).toBe(true);
    expect(complete("set openai/gpt-6 explore ")?.some((item) => item.label === "openai/gpt-6")).toBe(true);
    expect(complete("remove openai/gpt-6 ")?.some((item) => item.label === "explore")).toBe(true);
    expect(complete("move openai/gpt-6 ")?.some((item) => item.label === "bottom")).toBe(true);
    expect(complete("use-session ")?.some((item) => item.label === "off")).toBe(true);
    expect(complete("use-session ")?.some((item) => item.label === "focus")).toBe(true);
    expect(complete("log ")?.some((item) => item.label === "clear")).toBe(true);
    expect(complete("status ")?.some((item) => item.label === "off")).toBe(true);
    expect(complete("preset copy ")?.find((item) => item.label === "default")?.value).toBe(
      "preset copy default ",
    );
    expect(complete("--project add ")?.find((item) => item.label === "openai/gpt-6")?.value).toBe(
      "add openai/gpt-6 --project",
    );
    expect(complete("--project --")).toBeNull();
    expect(complete("set ")?.some((item) => item.label === "openai/gpt-6")).toBe(true);
    expect(complete("remove ")?.some((item) => item.label === "openai/gpt-6")).toBe(true);
    expect(complete("preset remove ")?.find((item) => item.label === "default")?.description).toContain(
      "active; switch away before removing",
    );
    expect(complete("preset zzz")).toBeNull();
    expect(complete("zzz")).toBeNull();
    expect(complete("log zzz")).toBeNull();
    expect(complete("status zzz")).toBeNull();
    expect(complete("unknown ")).toBeNull();
    expect(complete("move openai/gpt-6 extra ")).toBeNull();
  });

  test("returns null when the target has no config or the profile has a string default", () => {
    const empty = createHostHarness();
    empty.emitSessionStart({
      cwd: makeTempDir(),
      models: { current: () => undefined, resolve: () => undefined, list: () => [] },
    });
    const emptyComplete = empty.command().getArgumentCompletions!;
    expect(emptyComplete("set ")).toBeNull();
    expect(emptyComplete("preset use ")).toBeNull();
    expect(emptyComplete("use-session ")).toBeNull();
    expect(emptyComplete("add ")).toBeNull();

    const stringHost = createHostHarness();
    const stringCwd = makeTempDir();
    writeGlobal(stringCwd, { profiles: [{ main: "openai/gpt-6", subagents: "openai/mini" }] });
    stringHost.emitSessionStart({
      cwd: stringCwd,
      models: { current: () => ({ provider: "openai", id: "gpt-6" }), resolve: () => true, list: () => [] },
    });
    expect(stringHost.command().getArgumentCompletions!("remove openai/gpt-6 ")).toBeNull();
  });

  test("use-session completion follows the active layer", () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, { activePreset: "default", presets: { default: [] } });
    writeConfig(getProjectConfigPath(cwd), { activePreset: "project", presets: { project: [] } });
    host.emitSessionStart({
      cwd,
      models: { current: () => undefined, resolve: () => undefined, list: () => [] },
    });
    const complete = host.command().getArgumentCompletions!;
    expect(complete("use-session ")?.some((item) => item.label === "project")).toBe(true);
    expect(complete("use-session ")?.some((item) => item.label === "default")).toBe(false);
  });

  test("uses the cached session cwd and refreshes the model list on model_select", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      profiles: [{ main: "openai/gpt-6", subagents: { explore: "openai/mini" } }],
    });
    const other = makeTempDir();
    const ctx = modelCtx(cwd, {
      models: {
        current: () => ({ provider: "openai", id: "gpt-6" }),
        resolve: () => true,
        list: () => [{ provider: "openai", id: "gpt-6" }],
      },
    });
    host.emitSessionStart(ctx);
    const oldCwd = process.cwd();
    process.chdir(other);
    try {
      const complete = host.command().getArgumentCompletions!;
      expect(complete("set openai/gpt-6 ")?.some((item) => item.label === "explore")).toBe(true);
    } finally {
      process.chdir(oldCwd);
    }

    host.emitModelSelect(ctx, { provider: "anthropic", id: "claude-haiku-4" });
    const refreshed = host.command().getArgumentCompletions!("add ");
    expect(refreshed?.some((item) => item.label === "anthropic/claude-haiku-4")).toBe(true);
  });
});

describe("routing hooks", () => {
  test("leaves an explicit per-call model alone but routes a normal spawn", () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      profiles: [{ main: "openai/gpt-6", subagents: { explore: "openai/mini" } }],
    });
    const ctx = modelCtx(cwd);

    expect(
      host.emitSpawn(
        { agent: "explore", patterns: ["openai/explicit"], invocationKind: "task", modelRole: undefined },
        ctx,
      ),
    ).toBeUndefined();

    const routed = host.emitSpawn(
      { agent: "explore", patterns: ["openai/gpt-6"], invocationKind: "task", modelRole: undefined },
      ctx,
    ) as { model: string[] };
    expect(routed.model).toEqual(["openai/mini", "openai/gpt-6"]);

    const role = host.emitSpawn(
      { agent: "explore", patterns: ["openai/other"], invocationKind: "task", modelRole: "task" },
      ctx,
    ) as { model: string[] };
    expect(role.model).toEqual(["openai/mini", "openai/other"]);

    const legacyHost = host.emitSpawn({ agent: "explore", patterns: ["openai/other"] }, ctx) as {
      model: string[];
    };
    expect(legacyHost.model).toEqual(["openai/mini", "openai/other"]);
  });

  test("matches agent keys case-insensitively when the profile opts in", () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      profiles: [
        {
          main: "openai/gpt-6",
          subagents: { Explore: "openai/mini" },
          agentMatch: "case-insensitive",
        },
      ],
    });
    const ctx = modelCtx(cwd);
    const routed = host.emitSpawn({ agent: "explore" }, ctx) as { model: string[] };
    expect(routed.model).toEqual(["openai/mini"]);
  });

  test("warns once for an ambiguous adapter shape", () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, { profiles: [{ main: "*", subagents: { scout: "openai/mini" } }] });
    const warnings: string[] = [];
    const ctx = {
      ...modelCtx(cwd),
      mode: "tui",
      ui: { notify: (message: string) => warnings.push(message) },
    };
    const input = { name: "n", task: "t", title: "T", interactive: true, children: [{ agent: "scout" }] };
    expect(host.emitToolCall({ toolName: "subagent", input }, ctx)).toBeUndefined();
    expect(warnings.some((message) => message.includes("matches multiple subagent adapters"))).toBe(true);
  });

  test("warns when a plugin cannot express the selector and logs the skip", async () => {
    const host = createHostHarness({ tools: [AGENT_SCHEMA] });
    const cwd = makeTempDir();
    writeGlobal(cwd, { profiles: [{ main: "*", subagents: { Explore: "@smol" } }] });
    const warnings: string[] = [];
    const ctx = {
      ...modelCtx(cwd),
      mode: "tui",
      ui: { notify: (message: string) => warnings.push(message) },
    };
    const input: Record<string, unknown> = { subagent_type: "Explore", prompt: "x" };
    host.emitToolCall({ toolName: "Agent", input }, ctx);
    expect(warnings.some((message) => message.includes("cannot route @tintinweb/pi-subagents"))).toBe(true);
    expect("model" in input).toBe(false);

    const log = await host.runCommand("log", modelCtx(cwd));
    expect(log[0]?.message).toContain("skipped: selector not expressible in plugin dialect");
  });

  test("rejects a slash-containing bare id for an exact-only plugin", () => {
    const host = createHostHarness({ tools: [EDXETH_SCHEMA] });
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      profiles: [{ main: "*", subagents: { scout: "meta-llama/Llama-3.3-70B-Instruct" } }],
    });
    const warnings: string[] = [];
    const ctx = {
      cwd,
      mode: "tui",
      model: { provider: "google", id: "gpt-6" },
      modelRegistry: {
        getAvailable: () => [{ provider: "together", id: "meta-llama/Llama-3.3-70B-Instruct" }],
      },
      ui: { notify: (message: string) => warnings.push(message) },
    };
    const input: Record<string, unknown> = { agent: "scout", name: "n", task: "t", title: "T" };
    host.emitToolCall({ toolName: "subagent", input }, ctx);
    expect(warnings.some((message) => message.includes("cannot route edxeth/pi-subagents"))).toBe(true);
    expect("model" in input).toBe(false);
  });

  test("tool_call mutates in place and records the routed decision", async () => {
    const host = createHostHarness({ tools: [AGENT_SCHEMA] });
    const cwd = makeTempDir();
    writeGlobal(cwd, { profiles: [{ main: "*", subagents: { Explore: "anthropic/claude-haiku-4:high" } }] });
    const ctx = modelCtx(cwd);
    const input: Record<string, unknown> = { subagent_type: "Explore", prompt: "x" };
    expect(host.emitToolCall({ toolName: "Agent", input }, ctx)).toBeUndefined();
    expect(input).toEqual({
      subagent_type: "Explore",
      prompt: "x",
      model: "anthropic/claude-haiku-4",
      thinking: "high",
    });
    const log = await host.runCommand("log", ctx);
    expect(log[0]?.message).toContain("tool Explore");
    expect(log[0]?.message).toContain("adapter=tintinweb");
    expect(log[0]?.message).toContain("→ routed");
  });

  test("session_start and model_select registration failures are ignored", () => {
    const host = createHostHarness({ failSessionHook: true, failModelHook: true });
    expect(host.command()).toBeDefined();
  });

  test("a config with no active preset fails closed and names the reason", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, { presets: { daily: [{ main: "*", subagents: "openai/mini" }] } });
    const ctx = modelCtx(cwd);
    expect(host.emitSpawn({ agent: "explore" }, ctx)).toBeUndefined();
    const added = await host.runCommand("add foo bar", ctx);
    expect(added[0]?.message).toContain("No active preset is selected");
    const status = await host.runCommand("status", ctx);
    expect(status[0]?.message).toContain("No active preset is selected");
    expect(presetNames(readGlobal(cwd))).toEqual(["daily"]);
  });

  test("use-session validates the preset and reports available names", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, { presets: { daily: [] } });
    const ctx = modelCtx(cwd);
    const missing = await host.runCommand("use-session missing", ctx);
    expect(missing[0]?.level).toBe("warning");
    expect(missing[0]?.message).toContain("Available presets: daily");
    const invalid = await host.runCommand('use-session "bad name"', ctx);
    expect(invalid[0]?.level).toBe("warning");
  });

  test("preset use updates a visible status bar", async () => {
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const host = createHostHarness({ setStatus: (key, text) => statuses.push({ key, text }) });
    const cwd = makeTempDir();
    writeGlobal(cwd, {
      activePreset: "default",
      presets: { default: [], focus: [] },
    });
    const ctx = modelCtx(cwd);
    await host.runCommand("status", ctx);
    await host.runCommand("preset use focus", ctx);
    expect(statuses.at(-1)?.text).toBe("active: focus");
  });

  test("init refuses an existing file", async () => {
    const host = createHostHarness();
    const cwd = makeTempDir();
    writeGlobal(cwd, { profiles: [] });
    const result = await host.runCommand("init", modelCtx(cwd));
    expect(result[0]?.message).toContain("Config already exists");
  });

  test("projectActiveProfiles keeps disk and session selection separate", () => {
    const config: ModelSyncConfig = {
      activePreset: "default",
      presets: {
        default: [{ main: "*", subagents: "a" }],
        focus: [{ main: "*", subagents: "b" }],
      },
    };
    expect(projectActiveProfiles(config).activePreset).toBe("default");
    expect(projectActiveProfiles(config, { preset: "focus" }).activePreset).toBe("focus");
    expect(projectActiveProfiles(config, { paused: true }).warning).toContain("paused");
    expect(projectActiveProfiles(config, { preset: "missing" }).warning).toContain("does not exist");
    expect(getPresetProfiles(config, "focus")?.[0]?.subagents).toBe("b");
  });
});
