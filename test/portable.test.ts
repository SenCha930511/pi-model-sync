import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  cloneConfig,
  cloneProfiles,
  cloneSubagentMap,
  findProfile,
  getGlobalConfigPath,
  getPresetProfiles,
  getProjectConfigPath,
  isNamedConfig,
  isValidPresetName,
  pickSubagentSelector,
  presetNames,
  projectActiveProfiles,
  readConfig,
  readLayer,
  resolveActiveLayer,
  toPresetConfig,
  writeConfig,
} from "../config";
import type { ModelSyncConfig } from "../config";
import { createHostHarness, makeTempDir, useIsolatedConfig } from "./harness";

useIsolatedConfig();

const configModuleUrl = pathToFileURL(path.resolve(import.meta.dir, "..", "config.ts")).href;

describe("config paths and layer precedence", () => {
  test("PI_MODEL_SYNC_CONFIG overrides PI_CODING_AGENT_DIR and expands relative / ~/ paths", () => {
    const home = makeTempDir("home-");
    const cwd = makeTempDir("cwd-");
    process.env.PI_CODING_AGENT_DIR = path.join(home, "custom-agent");
    process.env.PI_MODEL_SYNC_CONFIG = "relative/sync.json";
    expect(getGlobalConfigPath(cwd)).toBe(path.resolve(cwd, "relative/sync.json"));

    // Run ~/ expansion and homedir() fallback in an isolated child process so Bun's startup
    // os.homedir() uses the temporary HOME/USERPROFILE instead of the developer's home.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete childEnv.PI_MODEL_SYNC_CONFIG;
    delete childEnv.PI_CODING_AGENT_DIR;
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
        import assert from "node:assert/strict";
        import path from "node:path";
        const { getGlobalConfigPath } = await import(${JSON.stringify(configModuleUrl)});
        const home = ${JSON.stringify(home)};
        const cwd = ${JSON.stringify(cwd)};
        process.env.PI_MODEL_SYNC_CONFIG = "~/override/sync.json";
        assert.equal(getGlobalConfigPath(cwd), path.resolve(home, "override/sync.json"));
        delete process.env.PI_MODEL_SYNC_CONFIG;
        process.env.PI_CODING_AGENT_DIR = "~/agent-dir";
        assert.equal(getGlobalConfigPath(cwd), path.resolve(home, "agent-dir", "pi-model-sync.json"));
        `,
      ],
      { env: childEnv, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
  });

  test("dual-host fallback prefers .omp when present, falls back to .pi when only .pi exists, and targets .omp when neither exists", () => {
    const home = makeTempDir("home-");
    const cwd = makeTempDir("cwd-");
    const ompGlobal = path.join(home, ".omp", "agent", "pi-model-sync.json");
    const piGlobal = path.join(home, ".pi", "agent", "pi-model-sync.json");

    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete childEnv.PI_MODEL_SYNC_CONFIG;
    delete childEnv.PI_CODING_AGENT_DIR;
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
        import assert from "node:assert/strict";
        import { mkdirSync, writeFileSync } from "node:fs";
        import path from "node:path";
        const { getGlobalConfigPath } = await import(${JSON.stringify(configModuleUrl)});
        const cwd = ${JSON.stringify(cwd)};
        const ompGlobal = ${JSON.stringify(ompGlobal)};
        const piGlobal = ${JSON.stringify(piGlobal)};
        assert.equal(getGlobalConfigPath(cwd), ompGlobal);
        mkdirSync(path.dirname(piGlobal), { recursive: true });
        writeFileSync(piGlobal, JSON.stringify({ profiles: [] }));
        assert.equal(getGlobalConfigPath(cwd), piGlobal);
        mkdirSync(path.dirname(ompGlobal), { recursive: true });
        writeFileSync(ompGlobal, JSON.stringify({ profiles: [] }));
        assert.equal(getGlobalConfigPath(cwd), ompGlobal);
        `,
      ],
      { env: childEnv, encoding: "utf8" },
    );
    expect(result.status).toBe(0);

    const ompProject = path.join(cwd, ".omp", "pi-model-sync.json");
    const piProject = path.join(cwd, ".pi", "pi-model-sync.json");
    expect(getProjectConfigPath(cwd)).toBe(ompProject);

    mkdirSync(path.dirname(piProject), { recursive: true });
    writeFileSync(piProject, "{ broken json");
    expect(getProjectConfigPath(cwd)).toBe(piProject);
    expect(resolveActiveLayer(cwd)).toEqual({ path: piProject, layer: "project" });
    expect(readConfig(cwd).profiles).toEqual([]);
    expect(readConfig(cwd).warning).toContain("Could not parse config file");
  });
});

describe("parsing, projection, cloning, and atomic writes", () => {
  test("missing file yields legacy empty config; empty or null activePreset fails closed", () => {
    const dir = makeTempDir();
    const missing = path.join(dir, "missing.json");
    const readMissing = readLayer(missing);
    expect(readMissing.exists).toBe(false);
    expect(readMissing.error).toBeNull();
    expect(projectActiveProfiles(readMissing.config)).toEqual({ activePreset: "default", profiles: [] });

    const unselected = path.join(dir, "unselected.json");
    writeFileSync(unselected, JSON.stringify({ activePreset: "", presets: { daily: [{ main: "*", subagents: "m" }] } }));
    const unselectedLayer = readLayer(unselected);
    expect(unselectedLayer.error).toBeNull();
    expect(projectActiveProfiles(unselectedLayer.config)).toEqual({
      profiles: [],
      warning: "No active preset is selected; no profiles are active.",
    });

    const nullPreset = path.join(dir, "null-preset.json");
    writeFileSync(nullPreset, JSON.stringify({ activePreset: null, presets: { daily: [{ main: "*", subagents: "m" }] } }));
    const nullLayer = readLayer(nullPreset);
    expect(nullLayer.error).toBeNull();
    expect(projectActiveProfiles(nullLayer.config)).toEqual({
      profiles: [],
      warning: "No active preset is selected; no profiles are active.",
    });

    const dangling = path.join(dir, "dangling.json");
    writeFileSync(dangling, JSON.stringify({ activePreset: "missing", presets: { daily: [{ main: "*", subagents: "m" }] } }));
    expect(projectActiveProfiles(readLayer(dangling).config)).toEqual({
      profiles: [],
      warning: 'Active preset "missing" does not exist; no profiles are active.',
    });
  });

  test("rejects structurally invalid config shapes and warns on invalid profile entries", () => {
    const dir = makeTempDir();
    const badShapes: Array<[unknown, string]> = [
      [[], "JSON object"],
      [{ profiles: [], presets: {} }, "cannot mix"],
      [{ activePreset: "a" }, 'also define a "presets"'],
      [{ profiles: "bad" }, '"profiles" must be an array'],
      [{ presets: [] }, '"presets" must be an object'],
      [{ presets: { "bad name": [] } }, "single tokens"],
      [{ presets: { a: "not-array" } }, "must be an array"],
      [{ activePreset: 123, presets: { a: [] } }, "string or null"],
      [{ profile: [] }, 'must define "profiles" or "presets"'],
    ];

    badShapes.forEach(([doc, expected], index) => {
      const file = path.join(dir, `bad-${index}.json`);
      writeFileSync(file, JSON.stringify(doc));
      const read = readLayer(file);
      expect(read.exists).toBe(true);
      expect(read.error).toContain(expected);
      expect(projectActiveProfiles(read.config).profiles).toEqual([]);
    });

    const dupFile = path.join(dir, "dup.json");
    writeFileSync(dupFile, '{"presets":{"a":[]," a ":[]}}');
    expect(readLayer(dupFile).error).toContain("Duplicate preset name");

    const warnFile = path.join(dir, "warn.json");
    // Raw JSON preserves "__proto__" as an own key in the parsed object.
    writeFileSync(
      warnFile,
      '{"profiles":["not-an-obj",{"main":" ","subagents":"x"},{"main":"a","subagents":{"":"x","valid":"y"}},{"main":"b","subagents":{"__proto__":"proto-model","*":"default-model"}}]}',
    );
    const warnRead = readLayer(warnFile);
    expect(warnRead.error).toBeNull();
    expect(warnRead.warnings.length).toBeGreaterThanOrEqual(3);
    expect(projectActiveProfiles(warnRead.config).profiles).toHaveLength(2);
    const second = projectActiveProfiles(warnRead.config).profiles[1]!;
    expect(pickSubagentSelector(second, "__proto__")).toBe("proto-model");
    expect(pickSubagentSelector(second, "toString")).toBe("default-model");
  });

  test("writeConfig validates, invalidates cache, and clones keep sibling presets isolated", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "nested", "config.json");
    const doc: ModelSyncConfig = {
      activePreset: "a",
      presets: {
        a: [{ main: "openai/gpt-6", subagents: { "*": "openai/mini", scout: "openai/scout" } }],
        b: [{ main: "anthropic/claude-*", subagents: "anthropic/haiku" }],
      },
    };
    writeConfig(file, doc);
    const read = readLayer(file);
    expect(read.exists).toBe(true);
    expect(read.error).toBeNull();

    const cloned = cloneConfig(read.config);
    expect(isNamedConfig(cloned)).toBe(true);
    if (isNamedConfig(cloned)) {
      cloned.presets.a![0]!.main = "mutated";
      expect((read.config as { presets: Record<string, Array<{ main: string }>> }).presets.a![0]!.main).toBe("openai/gpt-6");
      const nested = cloned.presets.a![0]!;
      if (typeof nested.subagents !== "string") {
        nested.subagents["scout"] = "mutated";
        delete nested.subagents["*"];
      }
      const cachedA = (read.config as {
        presets: Record<string, Array<{ subagents: Record<string, string> }>>;
      }).presets.a![0]!;
      expect(cachedA.subagents["*"]).toBe("openai/mini");
      expect(cachedA.subagents["scout"]).toBe("openai/scout");
      cloned.presets.b![0]!.main = "mutated";
      expect(getPresetProfiles(read.config, "b")?.[0]?.main).toBe("anthropic/claude-*");
      expect(presetNames(cloned)).toEqual(["a", "b"]);
      expect(getPresetProfiles(cloned, "b")?.[0]?.subagents).toBe("anthropic/haiku");
    }

    expect(() => writeConfig(file, { profiles: "bad" } as never)).toThrow(/Refusing to write/);
    expect(JSON.parse(readFileSync(file, "utf8")).activePreset).toBe("a");

    const converted = toPresetConfig({ profiles: cloneProfiles([{ main: "x", subagents: cloneSubagentMap({ "*": "y" }) }]) });
    expect(converted.activePreset).toBe("default");
    expect(isValidPresetName("good-name")).toBe(true);
    expect(isValidPresetName("bad name")).toBe(false);
    expect(isValidPresetName("")).toBe(false);
  });

  test("a content-changing rewrite is visible through the cache", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "cache.json");
    writeConfig(file, { activePreset: "a", presets: { a: [{ main: "openai/gpt-6", subagents: "openai/old" }] } });
    expect(projectActiveProfiles(readLayer(file).config).profiles[0]?.subagents).toBe("openai/old");

    writeConfig(file, { activePreset: "a", presets: { a: [{ main: "openai/gpt-6", subagents: "openai/new" }] } });
    expect(projectActiveProfiles(readLayer(file).config).profiles[0]?.subagents).toBe("openai/new");
  });

  test("warns on unknown keys and parses agentMatch", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "unknown.json");
    writeFileSync(
      file,
      JSON.stringify({
        profiles: [
          { main: "a", subagents: { Explore: "b" }, agentMatch: "case-insensitive", extra: true },
        ],
        extraRoot: 1,
      }),
    );
    const read = readLayer(file);
    expect(read.error).toBeNull();
    expect(read.warnings.some((warning) => warning.includes("extraRoot"))).toBe(true);
    expect(read.warnings.some((warning) => warning.includes('"extra"'))).toBe(true);
    const profile = projectActiveProfiles(read.config).profiles[0]!;
    expect(profile.agentMatch).toBe("case-insensitive");
    expect(pickSubagentSelector(profile, "explore")).toBe("b");
  });
});

describe("matching and selector picking", () => {
  test("first match wins, case-insensitive main, globs cross / and escape regex metacharacters", () => {
    const profiles = [
      { main: "openai/gpt-6.1+preview", subagents: "exact-meta" },
      { main: "anthropic/claude-*", subagents: "claude-glob" },
      { main: "gpt-6", subagents: "bare-match" },
      { main: "*", subagents: "catch-all" },
    ];
    expect(findProfile({ profiles }, { provider: "OpenAI", id: "GPT-6.1+Preview" })?.subagents).toBe("exact-meta");
    expect(findProfile({ profiles }, { provider: "OpenAI", id: "GPT-6X1+Preview" })?.subagents).toBe("catch-all");
    expect(findProfile({ profiles }, { provider: "anthropic", id: "claude-opus/4" })?.subagents).toBe("claude-glob");
    expect(findProfile({ profiles }, { provider: "azure", id: "gpt-6" })?.subagents).toBe("bare-match");
    expect(findProfile({ profiles }, { provider: "azure", id: "gpt-60" })?.subagents).toBe("catch-all");
    expect(findProfile({ profiles }, undefined)).toBeUndefined();
  });
});

describe("extension hooks (omp & upstream pi)", () => {

  test("registration skips an upstream-shaped setLabel", () => {
    const host = createHostHarness({ upstreamLabel: true });
    expect(host.labelCalls).toEqual([]);
    expect(host.label).toBeUndefined();
  });

  test("a hostile event after model resolution still returns undefined", () => {
    const host = createHostHarness();
    const dir = makeTempDir();
    writeConfig(path.join(dir, "sync.json"), {
      profiles: [{ main: "openai/gpt-6", subagents: { explore: "openai/mini" } }],
    });
    process.env.PI_MODEL_SYNC_CONFIG = path.join(dir, "sync.json");
    const ctx = {
      cwd: dir,
      models: {
        current: () => ({ provider: "openai", id: "gpt-6" }),
        resolve: () => true,
      },
    };
    try {
      expect(host.emitSpawn({ agent: "explore" }, ctx)).toBeDefined();
      const hostile: Record<string, unknown> = {};
      Object.defineProperty(hostile, "agent", {
        get() {
          throw new Error("hostile getter");
        },
        enumerable: true,
      });
      expect(host.emitSpawn(hostile, ctx)).toBeUndefined();
    } finally {
      delete process.env.PI_MODEL_SYNC_CONFIG;
    }
  });

  test("before_subagent_spawn routes, preserves fallback patterns, warns once in TUI, and never throws", () => {
    const dir = makeTempDir();
    const cfg = path.join(dir, "sync.json");
    process.env.PI_MODEL_SYNC_CONFIG = cfg;
    writeConfig(cfg, {
      profiles: [
        {
          main: "openai/gpt-6",
          subagents: {
            explore: "openai/gpt-6-mini",
            broken: "missing/model-xyz-unique-1",
            "*": "openai/gpt-6-luna",
          },
        },
      ],
    });

    const host = createHostHarness();
    expect(host.label).toBe("Model Sync");

    const routed = host.emitSpawn(
      { agent: { name: "explore" }, patterns: ["openai/gpt-6-mini", "openai/fallback"] },
      {
        cwd: dir,
        mode: "tui",
        models: {
          current: () => ({ provider: "openai", id: "gpt-6" }),
          resolve: (s: string) => s !== "missing/model-xyz-unique-1",
        },
      },
    ) as { model: string[]; note: string };
    expect(routed).toEqual({
      model: ["openai/gpt-6-mini", "openai/fallback"],
      note: "pi-model-sync: explore → openai/gpt-6-mini (main: openai/gpt-6)",
    });

    const warnings: string[] = [];
    const ctxWithBroken = {
      cwd: dir,
      mode: "tui",
      models: {
        current: () => ({ provider: "openai", id: "gpt-6" }),
        resolve: () => false,
      },
      ui: { notify: (msg: string) => warnings.push(msg) },
    };
    expect(host.emitSpawn({ agent: "broken" }, ctxWithBroken)).toBeUndefined();
    expect(host.emitSpawn({ agent: "broken" }, ctxWithBroken)).toBeUndefined();
    expect(warnings).toHaveLength(1);

    // Hostile context must never throw
    expect(
      host.emitSpawn(
        { agent: "explore" },
        {
          cwd: dir,
          models: {
            current: () => {
              throw new Error("boom");
            },
            resolve: () => true,
          },
        },
      ),
    ).toBeUndefined();
  });

  test("tool_call respects explicit model, shape guard, and upstream pi modelRegistry tiers", () => {
    const dir = makeTempDir();
    const cfg = path.join(dir, "sync.json");
    process.env.PI_MODEL_SYNC_CONFIG = cfg;
    writeConfig(cfg, {
      profiles: [
        {
          main: "claude-opus-4",
          subagents: {
            scout: "anthropic/claude-haiku-4:high",
            globber: "anthropic/claude-*",
            bare: "gpt-6-mini",
            aliasOnly: "@smol",
            bad: "missing/nope-unique-2",
            "*": "anthropic/claude-sonnet-4",
          },
        },
      ],
    });

    const host = createHostHarness({ failLabel: true, failSpawnHook: true });
    expect(host.label).toBeUndefined();

    // Non-subagent tool untouched
    expect(host.emitToolCall({ toolName: "read", input: { calls: [{ agent: "scout" }] } }, { cwd: dir })).toBeUndefined();

    let registryListCalls = 0;
    const findCalls: Array<[string, string]> = [];
    const upstreamCtx = {
      cwd: dir,
      mode: "tui",
      model: { provider: "anthropic", id: "claude-opus-4" },
      modelRegistry: {
        find(provider: string, id: string) {
          findCalls.push([provider, id]);
          return provider === "anthropic" && id === "claude-haiku-4" ? { provider, id } : undefined;
        },
        getAvailable() {
          registryListCalls += 1;
          return [{ provider: "openai", id: "gpt-6-mini" }];
        },
      },
      ui: { notify: () => {} },
    };

    const calls = [
      { agent: "scout", model: "explicit/override" },
      { agent: "scout", prompt: "a" },
      { agent: "globber", prompt: "b" },
      { agent: "bare", prompt: "c" },
      { agent: "aliasOnly", prompt: "d" },
      { agent: "bad", prompt: "e" },
      { agent: "unlisted", prompt: "f" },
    ];
    const input = { calls };
    expect(host.emitToolCall({ toolName: "subagent", input }, upstreamCtx)).toBeUndefined();
    expect(calls[0]!.model).toBe("explicit/override");
    expect(calls[1]!.model).toBe("anthropic/claude-haiku-4:high");
    expect(calls[2]!.model).toBe("anthropic/claude-*");
    expect(calls[3]!.model).toBe("gpt-6-mini");
    expect("model" in calls[4]!).toBe(false);
    expect("model" in calls[5]!).toBe(false);
    expect("model" in calls[6]!).toBe(false);
    expect(registryListCalls).toBe(1);
    expect(findCalls).toEqual([
      ["anthropic", "claude-haiku-4"],
      ["missing", "nope-unique-2"],
      ["anthropic", "claude-sonnet-4"],
    ]);
  });

  test("tool_call routes plugins detected from their registered schema", () => {
    const dir = makeTempDir();
    const cfg = path.join(dir, "sync.json");
    process.env.PI_MODEL_SYNC_CONFIG = cfg;
    writeConfig(cfg, {
      profiles: [
        {
          main: "openai/gpt-6",
          subagents: {
            Explore: "anthropic/claude-haiku-4:high",
            scout: "openai/gpt-6-mini",
            "*": "openai/gpt-6-luna",
          },
        },
      ],
    });

    const schema = (props: string[]) => ({
      type: "object",
      properties: Object.fromEntries(props.map((prop) => [prop, { type: "string" }])),
    });
    const tools = [
      { name: "Agent", parameters: schema(["prompt", "subagent_type", "model", "thinking"]) },
      { name: "subagent", parameters: schema(["agent", "task", "workflow", "action", "options", "model"]) },
    ];
    const host = createHostHarness({ tools });
    const ctx = {
      cwd: dir,
      mode: "tui",
      models: { current: () => ({ provider: "openai", id: "gpt-6" }), resolve: () => true },
    };

    const agentInput: Record<string, unknown> = { subagent_type: "Explore", prompt: "x" };
    expect(host.emitToolCall({ toolName: "Agent", input: agentInput }, ctx)).toBeUndefined();
    expect(agentInput).toEqual({
      subagent_type: "Explore",
      prompt: "x",
      model: "anthropic/claude-haiku-4",
      thinking: "high",
    });

    const explicit: Record<string, unknown> = { subagent_type: "Explore", prompt: "x", model: "explicit/model" };
    expect(host.emitToolCall({ toolName: "Agent", input: explicit }, ctx)).toBeUndefined();
    expect(explicit.model).toBe("explicit/model");

    const resumed: Record<string, unknown> = { subagent_type: "Explore", prompt: "x", resume: "abc" };
    expect(host.emitToolCall({ toolName: "Agent", input: resumed }, ctx)).toBeUndefined();

    const single: Record<string, unknown> = { agent: "scout", task: "x" };
    host.emitToolCall({ toolName: "subagent", input: single }, ctx);
    expect(single.model).toBe("openai/gpt-6-mini");

    const workflow: Record<string, unknown> = { workflow: true };
    host.emitToolCall({ toolName: "subagent", input: workflow }, ctx);
    expect(workflow.model).toBe("openai/gpt-6-luna");

    const fallbackHost = createHostHarness({ tools, failTools: true });
    const fallbackCalls: Array<Record<string, unknown>> = [{ agent: "scout" }];
    fallbackHost.emitToolCall({ toolName: "subagent", input: { calls: fallbackCalls } }, ctx);
    expect(fallbackCalls[0]?.model).toBe("openai/gpt-6-mini");
  });

  test("nicobailon skips a bare id that two providers expose", () => {
    const dir = makeTempDir();
    const cfg = path.join(dir, "sync.json");
    process.env.PI_MODEL_SYNC_CONFIG = cfg;
    writeConfig(cfg, {
      profiles: [{ main: "*", subagents: { scout: "gpt-x" } }],
    });

    const tool = {
      name: "subagent",
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          ["agent", "task", "workflow", "action", "options", "model"].map((prop) => [prop, { type: "string" }]),
        ),
      },
    };
    const host = createHostHarness({ tools: [tool] });
    const warnings: string[] = [];
    const ctx = {
      cwd: dir,
      mode: "tui",
      model: { provider: "google", id: "gpt-6" },
      modelRegistry: {
        getAvailable: () => [
          { provider: "openai", id: "gpt-x" },
          { provider: "anthropic", id: "gpt-x" },
        ],
      },
      ui: { notify: (message: string) => warnings.push(message) },
    };

    const ambiguous: Record<string, unknown> = { agent: "scout" };
    expect(host.emitToolCall({ toolName: "subagent", input: ambiguous }, ctx)).toBeUndefined();
    expect("model" in ambiguous).toBe(false);
    expect(warnings.some((message) => message.includes("matches more than one provider"))).toBe(true);

    const preferred: Record<string, unknown> = { agent: "scout" };
    host.emitToolCall(
      { toolName: "subagent", input: preferred },
      { ...ctx, model: { provider: "openai", id: "gpt-6" } },
    );
    expect(preferred.model).toBe("gpt-x");

    const uniqueCtx = {
      ...ctx,
      modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-x" }] },
    };
    const unique: Record<string, unknown> = { agent: "scout" };
    host.emitToolCall({ toolName: "subagent", input: unique }, uniqueCtx);
    expect(unique.model).toBe("gpt-x");
  });
});

describe("/model-sync commands and completions", () => {
  test("supports full lifecycle: onboarding, add/set/remove/move, presets, --project shadow hints, and completions", async () => {
    const cwd = makeTempDir("cwd-");
    const host = createHostHarness();
    const ctx = { cwd, models: { current: () => ({ provider: "openai", id: "gpt-6" }), resolve: () => true } };

    // First-run onboarding
    const firstList = await host.runCommand("list", ctx);
    expect(firstList[0]!.message).toContain("No config file yet.");
    const firstPresetList = await host.runCommand("preset list", ctx);
    expect(firstPresetList[0]!.message).toContain("No presets yet");

    // Add, set, move, show, remove
    await host.runCommand("add openai/gpt-6 openai/gpt-6-luna", ctx);
    await host.runCommand("set openai/gpt-6 explore openai/gpt-6-mini", ctx);
    await host.runCommand("add anthropic/* anthropic/haiku", ctx);
    const moveRes = await host.runCommand("move anthropic/* top", ctx);
    expect(moveRes[0]!.message).toContain("Moved profile anthropic/* to position 1 of 2");
    const edgeMove = await host.runCommand("move anthropic/* up", ctx);
    expect(edgeMove[0]!.level).toBe("warning");
    expect(edgeMove[0]!.message).toContain("already at the top");

    const showRes = await host.runCommand("show openai/gpt-6 explore", ctx);
    expect(showRes[0]!.message).toContain("explore → openai/gpt-6-mini (resolvable)");

    // Preset conversion, copy, rename, use, remove
    const createRes = await host.runCommand("preset create focus", ctx);
    expect(createRes[0]!.message).toContain('Legacy profiles moved to preset "default" (active)');
    await host.runCommand("preset copy default backup", ctx);
    await host.runCommand("preset rename backup archive", ctx);
    const activeRemoveRefusal = await host.runCommand("preset remove default", ctx);
    expect(activeRemoveRefusal[0]!.level).toBe("warning");
    await host.runCommand("preset use focus", ctx);
    await host.runCommand("preset remove archive", ctx);

    // Extra argument arity check
    const extraArg = await host.runCommand("list extra", ctx);
    expect(extraArg[0]!.level).toBe("warning");
    expect(extraArg[0]!.message).toContain("Unexpected argument");

    // Project override & shadow warning on global write
    await host.runCommand("add --project openai/gpt-6 openai/project-model", ctx);
    const shadow = await host.runCommand("add openai/gpt-6-sol openai/global-model", ctx);
    expect(shadow[0]!.message).toContain("overrides the global config. Add --project to edit it.");

    // Collapse back to string when only "*" remains
    await host.runCommand("preset use default", ctx);
    await host.runCommand("remove openai/gpt-6 explore", ctx);
    const globalRead = readLayer(getGlobalConfigPath(cwd));
    expect(getPresetProfiles(globalRead.config, "default")?.find((p) => p.main === "openai/gpt-6")?.subagents).toBe(
      "openai/gpt-6-luna",
    );

    // Fail closed when activePreset becomes empty string; preset use repairs it
    const globalPath = getGlobalConfigPath(cwd);
    const parsed = JSON.parse(readFileSync(globalPath, "utf8"));
    parsed.activePreset = "";
    writeFileSync(globalPath, JSON.stringify(parsed, null, 2));
    const refusedAdd = await host.runCommand("add foo bar", ctx);
    expect(refusedAdd[0]!.level).toBe("warning");
    expect(refusedAdd[0]!.message).toContain("No active preset is selected");
    await host.runCommand("preset use default", ctx);
    const repairedShow = await host.runCommand("list", ctx);
    expect(repairedShow[0]!.message).toContain("Active preset: default");

    // Completions preserve --project and avoid duplicating it
    const complete = host.command().getArgumentCompletions!;
    const oldCwd = process.cwd();
    process.chdir(cwd);
    try {
      const top = complete("");
      expect(top?.some((item) => item.label === "preset")).toBe(true);
      const projectFlag = complete("--");
      expect(projectFlag?.[0]?.value).toBe("--project");
      expect(complete("--project --")).toBeNull();
      const presetUse = complete("--project preset use ");
      expect(presetUse?.map((i) => i.value)).toEqual(["preset use default --project"]);
      const presetCopy = complete("preset copy ");
      expect(presetCopy?.find((i) => i.label === "default")?.value).toBe("preset copy default ");
      const setAgents = complete("set openai/gpt-6 ");
      expect(setAgents?.some((i) => i.label === "*")).toBe(true);
    } finally {
      process.chdir(oldCwd);
    }
  });
});
