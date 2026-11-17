import { describe, expect, test } from "bun:test";
import {
  ADAPTERS,
  applyModelSpec,
  matchesSchema,
  normalizeSelector,
  schemaProps,
  selectAdapter,
} from "../adapters";
import type { SubagentAdapter, ToolInfoLike } from "../adapters";

function schema(props: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(props.map((prop) => [prop, { type: "string" }])),
  };
}

function toolInfo(name: string, props: string[]): ToolInfoLike {
  return { name, parameters: schema(props) };
}

// Verified against pi-subagents@0.88.1, @tintinweb/pi-subagents@0.25.0,
// @gotgenes/pi-subagents@25.0.5, @mjakl/pi-subagent@3.1.0, and the HazAT/edxeth sources.
const mjaklTool: ToolInfoLike = {
  name: "subagent",
  parameters: {
    type: "object",
    properties: {
      calls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            agent: { type: "string" },
            task: { type: "string" },
            model: { type: "string" },
          },
        },
      },
    },
  },
};
const nicobailonTool = toolInfo("subagent", [
  "agent",
  "task",
  "workflow",
  "action",
  "options",
  "model",
  "cwd",
  "async",
  "id",
  "message",
]);
const gotgenesTool = toolInfo("subagent", [
  "prompt",
  "description",
  "subagent_type",
  "model",
  "thinking",
  "max_turns",
  "run_in_background",
  "resume",
]);
const tintinwebTool = toolInfo("Agent", [
  "prompt",
  "description",
  "subagent_type",
  "model",
  "thinking",
  "max_turns",
  "run_in_background",
  "resume",
]);
const hazatTool = toolInfo("subagent", [
  "name",
  "task",
  "agent",
  "systemPrompt",
  "model",
  "skills",
  "tools",
  "cwd",
  "fork",
  "interactive",
  "resumeSessionId",
]);
const edxethTool = toolInfo("subagent", ["name", "task", "title", "agent", "model", "thinking", "children"]);

function dialect(id: string) {
  const adapter = ADAPTERS.find((entry) => entry.id === id);
  if (!adapter) throw new Error(`missing adapter ${id}`);
  return adapter.dialect;
}

function adapterIdFor(
  toolName: string,
  input: Record<string, unknown>,
  tools?: readonly ToolInfoLike[],
): string | undefined {
  const selection = selectAdapter(toolName, input, tools);
  return selection.kind === "match" ? selection.adapter.id : undefined;
}

describe("schema fingerprints", () => {
  const fixtures: Array<{ id: string; tool: ToolInfoLike }> = [
    { id: "mjakl", tool: mjaklTool },
    { id: "nicobailon", tool: nicobailonTool },
    { id: "gotgenes", tool: gotgenesTool },
    { id: "tintinweb", tool: tintinwebTool },
    { id: "hazat", tool: hazatTool },
    { id: "edxeth", tool: edxethTool },
  ];

  test("each fixture matches only its own adapter among tools with the same name", () => {
    for (const fixture of fixtures) {
      const props = schemaProps(fixture.tool);
      const toolName = typeof fixture.tool.name === "string" ? fixture.tool.name : "";
      const sameName = ADAPTERS.filter((adapter) => adapter.toolNames.includes(toolName));
      for (const adapter of sameName) {
        expect({ fixture: fixture.id, adapter: adapter.id, match: matchesSchema(adapter, props) }).toEqual({
          fixture: fixture.id,
          adapter: adapter.id,
          match: adapter.id === fixture.id,
        });
      }
    }
  });

  test("a tool with no model field is not claimed", () => {
    const plain = toolInfo("subagent", ["agent", "task", "cwd"]);
    expect(adapterIdFor("subagent", { agent: "scout", task: "x" }, [plain])).toBeUndefined();
  });

  test("a structurally similar tool without a model field is not claimed", () => {
    const plain = toolInfo("subagent", ["agent", "task", "workflow", "action", "options"]);
    expect(adapterIdFor("subagent", { agent: "scout", task: "x" }, [plain])).toBeUndefined();
  });

  test("a nested or definition-only model field does not satisfy the fingerprint", () => {
    const nested: ToolInfoLike = {
      name: "Agent",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          subagent_type: { type: "string" },
          metadata: {
            type: "object",
            properties: { model: { type: "string" }, thinking: { type: "string" } },
          },
        },
      },
    };
    const props = schemaProps(nested);
    expect(props.has("metadata.model")).toBe(true);
    expect(props.has("model")).toBe(false);
    expect(matchesSchema(ADAPTERS.find((adapter) => adapter.id === "tintinweb")!, props)).toBe(false);

    const unreferenced: ToolInfoLike = {
      name: "Agent",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" }, subagent_type: { type: "string" } },
        $defs: { call: { type: "object", properties: { model: {}, thinking: {} } } },
      },
    };
    expect(matchesSchema(ADAPTERS.find((adapter) => adapter.id === "tintinweb")!, schemaProps(unreferenced))).toBe(
      false,
    );
  });

  test("resolves local $ref targets at the referencing position", () => {
    const referenced: ToolInfoLike = {
      name: "Agent",
      parameters: {
        type: "object",
        properties: {
          prompt: { $ref: "#/$defs/text" },
          subagent_type: { $ref: "#/$defs/text" },
          model: { $ref: "#/$defs/text" },
          thinking: { $ref: "#/$defs/text" },
        },
        $defs: { text: { type: "string" } },
      },
    };
    expect(matchesSchema(ADAPTERS.find((adapter) => adapter.id === "tintinweb")!, schemaProps(referenced))).toBe(
      true,
    );

    const wrapped: ToolInfoLike = {
      name: "Agent",
      parameters: {
        type: "object",
        properties: { input: { $ref: "#/$defs/input" } },
        $defs: {
          input: {
            type: "object",
            properties: { prompt: {}, subagent_type: {}, model: {}, thinking: {} },
          },
        },
      },
    };
    const wrappedProps = schemaProps(wrapped);
    expect(wrappedProps.has("input.model")).toBe(true);
    expect(wrappedProps.has("model")).toBe(false);
    expect(matchesSchema(ADAPTERS.find((adapter) => adapter.id === "tintinweb")!, wrappedProps)).toBe(false);
  });
});

describe("adapter selection", () => {
  test("same-named tools are separated by their call shape", () => {
    const tools = [mjaklTool, nicobailonTool, gotgenesTool, hazatTool, edxethTool];
    expect(adapterIdFor("subagent", { calls: [{ agent: "scout" }] }, tools)).toBe("mjakl");
    expect(adapterIdFor("subagent", { subagent_type: "Explore", prompt: "x" }, tools)).toBe("gotgenes");
    expect(adapterIdFor("subagent", { agent: "scout", task: "x" }, tools)).toBe("nicobailon");
    expect(adapterIdFor("subagent", { name: "n", task: "t", interactive: true }, tools)).toBe("hazat");
    expect(adapterIdFor("subagent", { name: "n", task: "t", title: "T" }, [edxethTool])).toBe("edxeth");
  });

  test("the Agent tool selects the tintinweb adapter", () => {
    expect(adapterIdFor("Agent", { subagent_type: "Explore", prompt: "x" }, [tintinwebTool])).toBe("tintinweb");
  });

  test("without getAllTools the call shape still selects the adapter", () => {
    expect(adapterIdFor("subagent", { calls: [{ agent: "scout" }] })).toBe("mjakl");
    expect(adapterIdFor("subagent", { subagent_type: "Explore", prompt: "x" })).toBe("gotgenes");
    expect(adapterIdFor("subagent", { agent: "scout", task: "x", options: {} })).toBe("nicobailon");
    expect(adapterIdFor("subagent", { name: "n", task: "t", interactive: true })).toBe("hazat");
    expect(adapterIdFor("subagent", { name: "n", task: "t", title: "T" })).toBe("edxeth");
    expect(adapterIdFor("subagent", { agent: "scout", task: "x" })).toBeUndefined();
  });

  test("schema drift falls back to the call shape", () => {
    const drifted = toolInfo("subagent", ["somethingElse"]);
    expect(adapterIdFor("subagent", { calls: [{ agent: "scout" }] }, [drifted])).toBe("mjakl");
  });

  test("an ambiguous fallback shape is skipped instead of guessed", () => {
    const input = { name: "n", task: "t", title: "T", interactive: true, children: [{ agent: "scout" }] };
    expect(adapterIdFor("subagent", input)).toBeUndefined();
    expect(adapterIdFor("subagent", { name: "n", task: "t" })).toBeUndefined();
  });

  test("an installed schema resolves a shape that is ambiguous without it", () => {
    const input = { name: "n", task: "t", title: "T" };
    expect(adapterIdFor("subagent", input, [hazatTool])).toBe("hazat");
    expect(adapterIdFor("subagent", input, [edxethTool])).toBe("edxeth");
    expect(adapterIdFor("subagent", input, [hazatTool, edxethTool])).toBeUndefined();
  });

  test("unrelated tools and unknown shapes pass through", () => {
    expect(adapterIdFor("read", { calls: [{ agent: "scout" }] })).toBeUndefined();
    expect(adapterIdFor("subagent", { calls: [] })).toBeUndefined();
    expect(adapterIdFor("subagent", {})).toBeUndefined();
  });
});

describe("explicit model and resume guards", () => {
  test("nicobailon never overwrites a top-level or options model", () => {
    expect(adapterIdFor("subagent", { agent: "scout", task: "x", model: "p/m" }, [nicobailonTool])).toBeUndefined();
    expect(
      adapterIdFor("subagent", { agent: "scout", task: "x", options: { model: "p/m" } }, [nicobailonTool]),
    ).toBeUndefined();
  });

  test("nicobailon skips management and resume actions", () => {
    expect(adapterIdFor("subagent", { action: "list" }, [nicobailonTool])).toBeUndefined();
    expect(adapterIdFor("subagent", { action: "resume", agent: "scout" }, [nicobailonTool])).toBeUndefined();
  });

  test("nicobailon accepts a direct call without a task", () => {
    const selection = selectAdapter("subagent", { agent: "scout" }, [nicobailonTool]);
    expect(selection.kind).toBe("match");
    if (selection.kind !== "match") return;
    expect(selection.slots.map((slot) => slot.agentName)).toEqual(["scout"]);
  });

  test("nicobailon structured items keep their own model", () => {
    const input = {
      tasks: [
        { agent: "scout", task: "a", model: "p/explicit" },
        { agent: "reviewer", task: "b" },
      ],
    };
    const selection = selectAdapter("subagent", input, [nicobailonTool]);
    expect(selection.kind).toBe("match");
    if (selection.kind !== "match") return;
    expect(selection.slots.map((slot) => slot.agentName)).toEqual(["reviewer"]);
  });

  test("nicobailon chain and parallel steps collect per agent", () => {
    const input = {
      chain: [
        { agent: "scout" },
        { parallel: [{ agent: "reviewer" }, { agent: "tester", model: "p/explicit" }] },
      ],
    };
    const selection = selectAdapter("subagent", input, [nicobailonTool]);
    expect(selection.kind).toBe("match");
    if (selection.kind !== "match") return;
    expect(selection.slots.map((slot) => slot.agentName)).toEqual(["scout", "reviewer"]);
  });

  test("nicobailon workflow uses the top-level default only", () => {
    const selection = selectAdapter("subagent", { workflow: true }, [nicobailonTool]);
    expect(selection.kind).toBe("match");
    if (selection.kind !== "match") return;
    expect(selection.slots).toEqual([{ record: { workflow: true }, agentName: "*" }]);
    expect(adapterIdFor("subagent", { workflow: "review", model: "p/m" }, [nicobailonTool])).toBeUndefined();
  });

  test("claude-style plugins skip resume and explicit models", () => {
    expect(adapterIdFor("Agent", { subagent_type: "Explore", prompt: "x", resume: "abc" }, [tintinwebTool])).toBeUndefined();
    expect(adapterIdFor("Agent", { subagent_type: "Explore", prompt: "x", model: "p/m" }, [tintinwebTool])).toBeUndefined();
    expect(adapterIdFor("subagent", { subagent_type: "Explore", prompt: "x", resume: true }, [gotgenesTool])).toBeUndefined();
  });

  test("HazAT skips resumed sessions and falls back to the * agent key", () => {
    expect(adapterIdFor("subagent", { name: "n", task: "t", resumeSessionId: "s" }, [hazatTool])).toBeUndefined();
    const selection = selectAdapter("subagent", { name: "n", task: "t" }, [hazatTool]);
    expect(selection.kind).toBe("match");
    if (selection.kind !== "match") return;
    expect(selection.slots[0]?.agentName).toBe("*");
  });

  test("edxeth collects children and keeps explicit child models", () => {
    const input = { children: [{ agent: "scout" }, { agent: "reviewer", model: "p/explicit" }] };
    const selection = selectAdapter("subagent", input, [edxethTool]);
    expect(selection.kind).toBe("match");
    if (selection.kind !== "match") return;
    expect(selection.slots.map((slot) => slot.agentName)).toEqual(["scout"]);

    expect(adapterIdFor("subagent", { model: "p/m", children: [{ agent: "scout" }] }, [edxethTool])).toBeUndefined();
  });

  test("edxeth falls back to * for a child without an agent", () => {
    const input = { children: [{}, { agent: "scout" }] };
    const selection = selectAdapter("subagent", input, [edxethTool]);
    expect(selection.kind).toBe("match");
    if (selection.kind !== "match") return;
    expect(selection.slots.map((slot) => slot.agentName)).toEqual(["*", "scout"]);
  });

  test("edxeth treats an empty children array as a single spawn", () => {
    const input = { name: "n", task: "t", title: "T", children: [] };
    const selection = selectAdapter("subagent", input, [edxethTool]);
    expect(selection.kind).toBe("match");
    if (selection.kind !== "match") return;
    expect(selection.slots).toHaveLength(1);
    expect(selection.slots[0]?.record).toBe(input);
  });

  test("mjakl keeps its existing per-call guard", () => {
    const input = { calls: [{ agent: "scout", model: "p/explicit" }, { agent: "reviewer" }] };
    const selection = selectAdapter("subagent", input, [mjaklTool]);
    expect(selection.kind).toBe("match");
    if (selection.kind !== "match") return;
    expect(selection.slots.map((slot) => slot.agentName)).toEqual(["reviewer"]);
  });
});

describe("selector dialects", () => {
  test("suffix dialects keep :level in the model", () => {
    expect(normalizeSelector("anthropic/claude-haiku-4:high", dialect("nicobailon"))).toEqual({
      base: "anthropic/claude-haiku-4:high",
    });
    expect(normalizeSelector("anthropic/claude-haiku-4:high", dialect("mjakl"))).toEqual({
      base: "anthropic/claude-haiku-4:high",
    });
  });

  test("field dialects split :level into thinking", () => {
    expect(normalizeSelector("anthropic/claude-haiku-4:high", dialect("tintinweb"))).toEqual({
      base: "anthropic/claude-haiku-4",
      thinking: "high",
    });
    expect(normalizeSelector("anthropic/claude-haiku-4", dialect("gotgenes"))).toEqual({
      base: "anthropic/claude-haiku-4",
    });
  });

  test("HazAT strips :level without writing a thinking field", () => {
    expect(normalizeSelector("anthropic/claude-haiku-4:high", dialect("hazat"))).toEqual({
      base: "anthropic/claude-haiku-4",
    });
  });

  test("alias and glob are rejected where the plugin cannot resolve them", () => {
    expect(normalizeSelector("@smol", dialect("mjakl"))).toEqual({ base: "@smol" });
    expect(normalizeSelector("anthropic/claude-*", dialect("mjakl"))).toEqual({ base: "anthropic/claude-*" });
    expect(normalizeSelector("@smol", dialect("tintinweb"))).toBeUndefined();
    expect(normalizeSelector("anthropic/claude-*", dialect("nicobailon"))).toBeUndefined();
  });

  test("an exact-only plugin rejects a bare id", () => {
    expect(normalizeSelector("claude-haiku-4", dialect("edxeth"))).toBeUndefined();
    expect(normalizeSelector("claude-haiku-4:high", dialect("edxeth"))).toBeUndefined();
    expect(normalizeSelector("anthropic/claude-haiku-4", dialect("edxeth"))).toEqual({
      base: "anthropic/claude-haiku-4",
    });
    expect(normalizeSelector("anthropic/claude-haiku-4:high", dialect("edxeth"))).toEqual({
      base: "anthropic/claude-haiku-4",
      thinking: "high",
    });
  });

  test("an unknown suffix stays part of the id", () => {
    expect(normalizeSelector("provider/model:beta", dialect("tintinweb"))).toEqual({
      base: "provider/model:beta",
    });
  });
});

describe("model injection", () => {
  test("writes the model and fills only an empty thinking field", () => {
    const empty: Record<string, unknown> = {};
    applyModelSpec({ record: empty, agentName: "scout" }, { base: "p/m", thinking: "high" }, dialect("tintinweb"));
    expect(empty).toEqual({ model: "p/m", thinking: "high" });

    const explicit: Record<string, unknown> = { thinking: "low" };
    applyModelSpec({ record: explicit, agentName: "scout" }, { base: "p/m", thinking: "high" }, dialect("tintinweb"));
    expect(explicit).toEqual({ model: "p/m", thinking: "low" });
  });

  test("does not write a thinking field for suffix dialects", () => {
    const record: Record<string, unknown> = {};
    applyModelSpec({ record, agentName: "scout" }, { base: "p/m:high" }, dialect("nicobailon"));
    expect(record).toEqual({ model: "p/m:high" });
  });

  test("adapter table has unique ids and tool names", () => {
    const ids = ADAPTERS.map((adapter) => adapter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("adapter ids are the ones the routing tests expect", () => {
    const ids: Array<SubagentAdapter["id"]> = ADAPTERS.map((adapter) => adapter.id);
    expect(ids).toEqual(["mjakl", "nicobailon", "tintinweb", "gotgenes", "hazat", "edxeth"]);
  });
});
