import { describe, expect, test } from "bun:test";
import { ADAPTERS } from "../adapters";
import {
  adapterAcceptsSelector,
  availableModelIds,
  bareSelectorUnique,
  createRegistrySnapshot,
  formatModelRef,
  installedAdapters,
  parseSelector,
  piSelectorResolvable,
  readToolInfos,
  sameModelRef,
  selectorKind,
  selectorRefs,
} from "../resolver";
import type { ExtensionContextLike, ModelRegistryFacade } from "../resolver";

function model(provider: string, id: string): Record<string, string> {
  return { provider, id };
}

function registry(
  entries: unknown[],
  find?: (provider: string, id: string) => unknown,
  auth?: (model: unknown) => boolean,
): ModelRegistryFacade {
  return {
    getAvailable: () => entries,
    ...(find ? { find } : {}),
    ...(auth ? { hasConfiguredAuth: auth } : {}),
  };
}

function upstream(entries: unknown[], current?: Record<string, string>): ExtensionContextLike {
  return { cwd: "/tmp", model: current, modelRegistry: registry(entries) };
}

function omp(entries: unknown[], current?: Record<string, string>): ExtensionContextLike {
  return {
    cwd: "/tmp",
    models: {
      current: () => current,
      resolve: () => undefined,
      list: () => entries,
    },
  };
}

describe("selector parsing", () => {
  test("strips a known thinking suffix and keeps unknown suffixes in the id", () => {
    expect(parseSelector("anthropic/claude-haiku-4:high")).toEqual({
      raw: "anthropic/claude-haiku-4:high",
      base: "anthropic/claude-haiku-4",
      thinking: "high",
      kind: "reference",
      provider: "anthropic",
      id: "claude-haiku-4",
    });
    expect(parseSelector("provider/model:beta")).toEqual({
      raw: "provider/model:beta",
      base: "provider/model:beta",
      kind: "reference",
      provider: "provider",
      id: "model:beta",
    });
  });

  test("classifies aliases, globs, bare ids, and malformed selectors", () => {
    expect(parseSelector("@smol")?.kind).toBe("alias");
    expect(parseSelector("anthropic/claude-*")?.kind).toBe("glob");
    expect(parseSelector("gpt-6")?.kind).toBe("reference");
    expect(parseSelector("gpt-6")?.provider).toBeUndefined();
    expect(parseSelector("meta-llama/Llama-3.3-70B-Instruct")?.provider).toBe("meta-llama");
    expect(parseSelector("/leading")).toBeUndefined();
    expect(parseSelector("provider/")).toBeUndefined();
    expect(parseSelector("   ")).toBeUndefined();
  });

  test("offers provider/id first and the whole base as a bare id second", () => {
    const slash = parseSelector("meta-llama/Llama-3.3-70B-Instruct");
    expect(slash).toBeDefined();
    if (!slash) return;
    expect(selectorRefs(slash)).toEqual([
      { provider: "meta-llama", id: "Llama-3.3-70B-Instruct" },
      { provider: "", id: "meta-llama/Llama-3.3-70B-Instruct" },
    ]);
    const bare = parseSelector("gpt-6:low");
    expect(bare).toBeDefined();
    if (!bare) return;
    expect(selectorRefs(bare)).toEqual([{ provider: "", id: "gpt-6" }]);
    expect(selectorRefs(parseSelector("anthropic/*")!)).toEqual([]);
  });
});

describe("upstream registry resolution", () => {
  test("find plus configured auth decides provider/id selectors", () => {
    const found = model("openai", "gpt-6");
    const snapshot = createRegistrySnapshot();
    const configured = registry([], (provider, id) => (provider === "openai" && id === "gpt-6" ? found : undefined), (entry) => {
      return Boolean(entry && typeof entry === "object" && "provider" in entry && entry.provider === "openai");
    });
    expect(piSelectorResolvable("openai/gpt-6", configured, snapshot)).toBe(true);

    const unconfigured = registry([], () => found, () => false);
    expect(piSelectorResolvable("openai/gpt-6", unconfigured, createRegistrySnapshot())).toBe(false);
  });

  test("falls back to a bare id that itself contains a slash", () => {
    const snapshot = createRegistrySnapshot();
    const reg = registry([model("together", "meta-llama/Llama-3.3-70B-Instruct")]);
    expect(piSelectorResolvable("meta-llama/Llama-3.3-70B-Instruct", reg, snapshot)).toBe(true);
    expect(snapshot.resolved.get("meta-llama/Llama-3.3-70B-Instruct")).toBe(true);
  });

  test("passes globs through, rejects aliases, and shares the level-stripped cache", () => {
    const snapshot = createRegistrySnapshot();
    let finds = 0;
    const reg = registry([], (provider, id) => {
      finds += 1;
      return provider === "openai" && id === "gpt-6" ? model(provider, id) : undefined;
    });
    expect(piSelectorResolvable("anthropic/*", reg, snapshot)).toBe(true);
    expect(piSelectorResolvable("@smol", reg, snapshot)).toBe(false);
    expect(piSelectorResolvable("openai/gpt-6:low", reg, snapshot)).toBe(true);
    expect(piSelectorResolvable("openai/gpt-6:high", reg, snapshot)).toBe(true);
    expect(finds).toBe(1);
  });

  test("classifies provider/id, bare slash ids, and unknown selectors", () => {
    const ctx = upstream([
      model("openai", "gpt-6"),
      model("together", "meta-llama/Llama-3.3-70B-Instruct"),
    ]);
    expect(selectorKind(ctx, "openai/gpt-6")).toBe("provider-id");
    expect(selectorKind(ctx, "meta-llama/Llama-3.3-70B-Instruct")).toBe("bare");
    expect(selectorKind(ctx, "missing/model")).toBe("unknown");
    expect(selectorKind(ctx, "@smol")).toBe("alias");
    expect(selectorKind(ctx, "openai/*")).toBe("glob");
  });

  test("filters getAll-only registries through hasConfiguredAuth", () => {
    const reg: ModelRegistryFacade = {
      getAll: () => [
        { provider: "openai", id: "gpt-x" },
        { provider: "anthropic", id: "gpt-x" },
      ],
      hasConfiguredAuth: (entry) =>
        Boolean(entry && typeof entry === "object" && "provider" in entry && entry.provider === "openai"),
    };
    const ctx: ExtensionContextLike = {
      cwd: "/tmp",
      model: { provider: "google", id: "gpt-6" },
      modelRegistry: reg,
    };
    expect(bareSelectorUnique(ctx, "gpt-x", createRegistrySnapshot(), undefined)).toBe(true);
    expect(selectorKind(ctx, "anthropic/gpt-x")).toBe("unknown");
    expect(availableModelIds(ctx)).toEqual(["openai/gpt-x", "gpt-x"]);
    expect(piSelectorResolvable("anthropic/gpt-x", reg, createRegistrySnapshot())).toBe(false);
  });
});

describe("bare id uniqueness", () => {
  test("uses omp's authenticated list and counts providers", () => {
    const snapshot = createRegistrySnapshot();
    const ambiguous = omp([model("openai", "gpt-x"), model("anthropic", "gpt-x")], model("google", "gpt-6"));
    expect(bareSelectorUnique(ambiguous, "gpt-x", snapshot, { provider: "google", id: "gpt-6" })).toBe(false);

    const preferred = omp([model("openai", "gpt-x"), model("anthropic", "gpt-x")], model("openai", "gpt-6"));
    expect(bareSelectorUnique(preferred, "gpt-x", createRegistrySnapshot(), { provider: "openai", id: "gpt-6" })).toBe(true);

    const unique = omp([model("openai", "gpt-x")], model("google", "gpt-6"));
    expect(bareSelectorUnique(unique, "gpt-x", createRegistrySnapshot(), { provider: "google", id: "gpt-6" })).toBe(true);

    const providerId = omp([model("openai", "gpt-x")]);
    expect(bareSelectorUnique(providerId, "openai/gpt-x", createRegistrySnapshot(), undefined)).toBeUndefined();
  });

  test("counts a slash-containing bare id by its full id", () => {
    const entries = [
      model("together", "meta-llama/Llama-3"),
      model("openrouter", "meta-llama/Llama-3"),
    ];
    expect(bareSelectorUnique(omp(entries), "meta-llama/Llama-3", createRegistrySnapshot(), undefined)).toBe(false);
    expect(
      bareSelectorUnique(omp([entries[0]!]), "meta-llama/Llama-3", createRegistrySnapshot(), undefined),
    ).toBe(true);
  });

  test("returns undefined when the host cannot enumerate models", () => {
    expect(bareSelectorUnique({ cwd: "/tmp" }, "gpt-x", createRegistrySnapshot(), undefined)).toBeUndefined();
  });

  test("lists provider/id and bare forms for completion", () => {
    expect(availableModelIds(omp([model("openai", "gpt-6")]))).toEqual(["openai/gpt-6", "gpt-6"]);
    expect(availableModelIds({ cwd: "/tmp" })).toEqual([]);
  });
});

describe("plugin dialect checks", () => {
  const edxeth = ADAPTERS.find((adapter) => adapter.id === "edxeth")!;
  const nicobailon = ADAPTERS.find((adapter) => adapter.id === "nicobailon")!;
  const mjakl = ADAPTERS.find((adapter) => adapter.id === "mjakl")!;

  test("rejects a slash-containing bare id for an exact-only plugin", () => {
    const ctx = upstream([model("together", "meta-llama/Llama-3")]);
    expect(adapterAcceptsSelector(ctx, "meta-llama/Llama-3", edxeth, createRegistrySnapshot())).toBe(false);
    expect(
      adapterAcceptsSelector(ctx, "together/meta-llama/Llama-3", edxeth, createRegistrySnapshot()),
    ).toBe(true);
  });

  test("an exact-only plugin rejects selectors the host cannot confirm as provider/id", () => {
    const noEnumeration: ExtensionContextLike = {
      cwd: "/tmp",
      models: {
        current: () => ({ provider: "openai", id: "gpt-6" }),
        resolve: () => true,
      },
    };
    expect(selectorKind(noEnumeration, "meta-llama/Llama-3")).toBe("unknown");
    expect(adapterAcceptsSelector(noEnumeration, "meta-llama/Llama-3", edxeth, createRegistrySnapshot())).toBe(
      false,
    );

    const failingList: ExtensionContextLike = {
      cwd: "/tmp",
      models: {
        current: () => ({ provider: "openai", id: "gpt-6" }),
        resolve: () => true,
        list: () => {
          throw new Error("catalog unavailable");
        },
      },
    };
    const snapshot = createRegistrySnapshot();
    expect(selectorKind(failingList, "meta-llama/Llama-3", snapshot)).toBe("unknown");
    expect(adapterAcceptsSelector(failingList, "meta-llama/Llama-3", edxeth, createRegistrySnapshot())).toBe(
      false,
    );
  });

  test("rejects an ambiguous bare id for nicobailon", () => {
    const ctx = omp([model("openai", "gpt-x"), model("anthropic", "gpt-x")], model("google", "gpt-6"));
    expect(adapterAcceptsSelector(ctx, "gpt-x", nicobailon, createRegistrySnapshot())).toBe(false);
    expect(
      adapterAcceptsSelector(ctx, "gpt-x", nicobailon, createRegistrySnapshot(), { provider: "openai", id: "gpt-6" }),
    ).toBe(true);
  });

  test("accepts globs only where the dialect allows them", () => {
    const ctx = upstream([model("openai", "gpt-6")]);
    expect(adapterAcceptsSelector(ctx, "openai/*", mjakl, createRegistrySnapshot())).toBe(true);
    expect(adapterAcceptsSelector(ctx, "openai/*", nicobailon, createRegistrySnapshot())).toBe(false);
  });
});

describe("tool detection", () => {
  const agentTool = {
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

  test("readToolInfos tolerates a missing or throwing host", () => {
    expect(readToolInfos(undefined)).toBeUndefined();
    expect(readToolInfos({})).toBeUndefined();
    expect(
      readToolInfos({
        getAllTools() {
          throw new Error("boom");
        },
      }),
    ).toBeUndefined();
    expect(readToolInfos({ getAllTools: () => [agentTool, null, "bad"] })).toEqual([agentTool]);
  });

  test("installedAdapters distinguishes unknown from empty", () => {
    expect(installedAdapters(undefined)).toBeUndefined();
    expect(installedAdapters([])).toEqual([]);
    expect(installedAdapters([agentTool])?.map((adapter) => adapter.id)).toEqual(["tintinweb"]);
  });

  test("model refs compare with an optional provider", () => {
    expect(sameModelRef({ provider: "OpenAI", id: "GPT-6" }, { provider: "openai", id: "gpt-6" })).toBe(true);
    expect(sameModelRef({ provider: "", id: "gpt-6" }, { provider: "openai", id: "gpt-6" })).toBe(true);
    expect(sameModelRef({ provider: "openai", id: "gpt-6" }, { provider: "anthropic", id: "gpt-6" })).toBe(false);
    expect(formatModelRef({ provider: "openai", id: "gpt-6" })).toBe("openai/gpt-6");
    expect(formatModelRef({ provider: "", id: "gpt-6" })).toBe("gpt-6");
    expect(formatModelRef(undefined)).toBe("(unknown)");
  });
});
