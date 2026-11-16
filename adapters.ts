/**
 * Subagent plugin adapters: identify the registered tool behind a `tool_call`, split
 * its input into injectable call slots, and translate a profile selector into that
 * plugin's model dialect. Pure functions; no host imports, no I/O, no globals.
 *
 * Detection is two-stage. The registered tool schema (`pi.getAllTools()`) narrows the
 * set of installed plugins, then the call shape picks the adapter that handles this
 * input. A host without `getAllTools()` falls back to call shape alone. Adapters only
 * claim a call when they can actually inject into it, so an explicit model, a resume,
 * or a management action yields no slot and therefore no adapter.
 */

export type ThinkingMode = "suffix" | "field" | "none";

/** How a plugin accepts a `:level` suffix and which fields it reads. */
export interface SelectorDialect {
  thinking: ThinkingMode;
  thinkingField?: string;
  allowAlias: boolean;
  allowGlob: boolean;
  allowBareId: boolean;
}

export interface ModelSpec {
  base: string;
  thinking?: string;
}

export interface CallSlot {
  record: Record<string, unknown>;
  agentName: string;
}

export interface ToolInfoLike {
  name?: unknown;
  parameters?: unknown;
}

export interface SubagentAdapter {
  id: string;
  label: string;
  toolNames: readonly string[];
  requiredProps: readonly string[];
  forbiddenProps: readonly string[];
  /** Without a schema, at least one of these must be present to claim the call. */
  fallbackProps: readonly string[];
  dialect: SelectorDialect;
  collect(input: Record<string, unknown>): CallSlot[];
}

export type AdapterSelection =
  | { kind: "match"; adapter: SubagentAdapter; slots: CallSlot[] }
  | { kind: "ambiguous"; adapters: readonly SubagentAdapter[] }
  | { kind: "none" };

/** Upstream pi's ThinkingLevel set; a selector suffix outside it is part of the id. */
export const THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function nonBlank(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A resume flag is set when it is anything other than absent, null, false, or "". */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "";
}

function collectMjakl(input: Record<string, unknown>): CallSlot[] {
  const calls = input.calls;
  if (!Array.isArray(calls)) return [];
  const slots: CallSlot[] = [];
  for (const call of calls) {
    if (!isRecord(call)) continue;
    const agentName = nonBlank(call.agent);
    if (!agentName || nonBlank(call.model)) continue;
    slots.push({ record: call, agentName });
  }
  return slots;
}

function collectNicobailonTasks(value: unknown, slots: CallSlot[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const agentName = nonBlank(item.agent);
    if (!agentName || !nonBlank(item.task) || nonBlank(item.model)) continue;
    slots.push({ record: item, agentName });
  }
}

function collectNicobailonChain(value: unknown, slots: CallSlot[]): void {
  if (!Array.isArray(value)) return;
  for (const step of value) {
    if (!isRecord(step)) continue;
    if (Array.isArray(step.parallel)) {
      collectNicobailonChain(step.parallel, slots);
      continue;
    }
    const agentName = nonBlank(step.agent);
    if (!agentName || nonBlank(step.model)) continue;
    slots.push({ record: step, agentName });
  }
}

function collectNicobailon(input: Record<string, unknown>): CallSlot[] {
  if (nonBlank(input.action)) return [];
  if (nonBlank(input.model)) return [];
  if (isRecord(input.options) && nonBlank(input.options.model)) return [];
  const workflow = input.workflow;
  if (workflow === true || nonBlank(workflow)) {
    // A workflow script spawns its own children; the top-level model is the only seam
    // and becomes their default. Their explicit per-child model still wins.
    return [{ record: input, agentName: "*" }];
  }
  const slots: CallSlot[] = [];
  const agentName = nonBlank(input.agent);
  if (agentName && nonBlank(input.task)) slots.push({ record: input, agentName });
  collectNicobailonTasks(input.tasks, slots);
  collectNicobailonChain(input.chain, slots);
  return slots;
}

/** @tintinweb/pi-subagents `Agent` and its @gotgenes fork `subagent`. */
function collectClaudeStyle(input: Record<string, unknown>): CallSlot[] {
  if (isSet(input.resume) || nonBlank(input.model)) return [];
  const agentName = nonBlank(input.subagent_type);
  if (!agentName || !nonBlank(input.prompt)) return [];
  return [{ record: input, agentName }];
}

function collectHazat(input: Record<string, unknown>): CallSlot[] {
  if (nonBlank(input.resumeSessionId) || nonBlank(input.model)) return [];
  if (!nonBlank(input.name) || !nonBlank(input.task)) return [];
  return [{ record: input, agentName: nonBlank(input.agent) ?? "*" }];
}

function collectEdxeth(input: Record<string, unknown>): CallSlot[] {
  if (nonBlank(input.model)) return [];
  const children = input.children;
  if (Array.isArray(children)) {
    const slots: CallSlot[] = [];
    for (const child of children) {
      if (!isRecord(child)) continue;
      const agentName = nonBlank(child.agent);
      if (!agentName || nonBlank(child.model)) continue;
      slots.push({ record: child, agentName });
    }
    return slots;
  }
  if (!nonBlank(input.task) || !nonBlank(input.title)) return [];
  return [{ record: input, agentName: nonBlank(input.agent) ?? "*" }];
}

export const ADAPTERS: readonly SubagentAdapter[] = [
  {
    id: "mjakl",
    label: "@mjakl/pi-subagent",
    toolNames: ["subagent"],
    requiredProps: ["calls"],
    forbiddenProps: ["subagent_type", "workflow", "name", "children", "tasks", "chain"],
    fallbackProps: ["calls"],
    // Unchanged legacy behavior: the selector is passed through verbatim and the host
    // or child process resolves aliases, globs, and the :level suffix.
    dialect: { thinking: "suffix", allowAlias: true, allowGlob: true, allowBareId: true },
    collect: collectMjakl,
  },
  {
    id: "nicobailon",
    label: "pi-subagents",
    toolNames: ["subagent"],
    requiredProps: ["agent", "task", "workflow", "action", "options"],
    forbiddenProps: ["calls", "subagent_type", "children", "resumeSessionId"],
    fallbackProps: ["options", "workflow", "tasks", "chain", "action"],
    dialect: { thinking: "suffix", allowAlias: false, allowGlob: false, allowBareId: true },
    collect: collectNicobailon,
  },
  {
    id: "tintinweb",
    label: "@tintinweb/pi-subagents",
    toolNames: ["Agent"],
    requiredProps: ["prompt", "subagent_type", "model", "thinking"],
    forbiddenProps: ["calls", "workflow", "children", "tasks", "chain"],
    fallbackProps: ["subagent_type"],
    dialect: { thinking: "field", thinkingField: "thinking", allowAlias: false, allowGlob: false, allowBareId: true },
    collect: collectClaudeStyle,
  },
  {
    id: "gotgenes",
    label: "@gotgenes/pi-subagents",
    toolNames: ["subagent"],
    requiredProps: ["prompt", "subagent_type"],
    forbiddenProps: ["calls", "workflow", "children", "tasks", "chain"],
    fallbackProps: ["subagent_type"],
    dialect: { thinking: "field", thinkingField: "thinking", allowAlias: false, allowGlob: false, allowBareId: true },
    collect: collectClaudeStyle,
  },
  {
    id: "hazat",
    label: "pi-interactive-subagents",
    toolNames: ["subagent"],
    requiredProps: ["name", "task", "interactive", "resumeSessionId"],
    forbiddenProps: ["subagent_type", "calls", "children", "workflow"],
    fallbackProps: ["interactive", "resumeSessionId"],
    // The plugin appends its own `:thinking` from agent frontmatter; a suffix here
    // would produce `model:level:level`, so strip it and inject the base only.
    dialect: { thinking: "none", allowAlias: false, allowGlob: false, allowBareId: true },
    collect: collectHazat,
  },
  {
    id: "edxeth",
    label: "edxeth/pi-subagents",
    toolNames: ["subagent"],
    requiredProps: ["name", "task", "title", "children"],
    forbiddenProps: ["subagent_type", "calls", "workflow"],
    fallbackProps: ["title", "children"],
    // This plugin wants an exact provider/model id; a bare id is skipped rather than
    // guessed, because the wrong provider would be worse than default routing.
    dialect: { thinking: "field", thinkingField: "thinking", allowAlias: false, allowGlob: false, allowBareId: false },
    collect: collectEdxeth,
  },
];

export const ADAPTER_TOOL_NAMES: ReadonlySet<string> = new Set(
  ADAPTERS.flatMap((adapter) => adapter.toolNames),
);

function collectSchemaProps(schema: unknown, into: Set<string>, depth: number): void {
  if (!isRecord(schema) || depth > 4) return;
  const properties = schema.properties;
  if (isRecord(properties)) {
    for (const key of Object.keys(properties)) into.add(key);
  }
  const items = schema.items;
  if (isRecord(items)) collectSchemaProps(items, into, depth + 1);
  else if (Array.isArray(items)) {
    for (const item of items) collectSchemaProps(item, into, depth + 1);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) collectSchemaProps(branch, into, depth + 1);
    }
  }
}

export function schemaProps(info: ToolInfoLike): Set<string> {
  const props = new Set<string>();
  collectSchemaProps(info.parameters, props, 0);
  return props;
}

export function matchesSchema(adapter: SubagentAdapter, props: ReadonlySet<string>): boolean {
  return (
    adapter.requiredProps.every((prop) => props.has(prop)) &&
    !adapter.forbiddenProps.some((prop) => props.has(prop))
  );
}

export function selectAdapter(
  toolName: string,
  input: Record<string, unknown>,
  tools?: readonly ToolInfoLike[],
): AdapterSelection {
  const candidates = ADAPTERS.filter((adapter) => adapter.toolNames.includes(toolName));
  if (candidates.length === 0) return { kind: "none" };
  const infos = tools ? tools.filter((info) => info.name === toolName) : [];
  const installed =
    infos.length === 0
      ? []
      : candidates.filter((adapter) =>
          infos.some((info) => matchesSchema(adapter, schemaProps(info))),
        );
  // Schema drift or a host without getAllTools(): fall back to the call shape. The
  // fallback props keep an ambiguous shape ({agent, task} alone) from claiming a tool
  // that may belong to an unsupported plugin with additionalProperties: false.
  const pool =
    installed.length > 0
      ? installed
      : candidates.filter((adapter) =>
          adapter.fallbackProps.some((prop) => Object.hasOwn(input, prop)),
        );
  const matched: Array<{ adapter: SubagentAdapter; slots: CallSlot[] }> = [];
  for (const adapter of pool) {
    const slots = adapter.collect(input);
    if (slots.length > 0) matched.push({ adapter, slots });
  }
  if (matched.length === 1) {
    const only = matched[0];
    if (only) return { kind: "match", adapter: only.adapter, slots: only.slots };
  }
  if (matched.length === 0) return { kind: "none" };
  return { kind: "ambiguous", adapters: matched.map((entry) => entry.adapter) };
}

/**
 * Translate a profile selector into the adapter's dialect. `undefined` means the
 * selector cannot be expressed for this plugin; the caller warns and leaves the
 * plugin's default routing in place.
 */
export function normalizeSelector(selector: string, dialect: SelectorDialect): ModelSpec | undefined {
  let base = selector.trim();
  if (!base) return undefined;
  if (base.startsWith("@")) return dialect.allowAlias ? { base } : undefined;
  if (base.includes("*")) return dialect.allowGlob ? { base } : undefined;
  const colon = base.lastIndexOf(":");
  const suffix = colon > 0 ? base.slice(colon + 1) : "";
  if (suffix && THINKING_LEVELS.has(suffix)) {
    if (dialect.thinking === "field") {
      base = base.slice(0, colon);
      return base ? { base, thinking: suffix } : undefined;
    }
    if (dialect.thinking === "none") {
      base = base.slice(0, colon);
      if (!base) return undefined;
    }
  }
  if (!dialect.allowBareId && !base.includes("/")) return undefined;
  return { base };
}

/** Write the model (and the split thinking level, when the plugin has a field). */
export function applyModelSpec(slot: CallSlot, spec: ModelSpec, dialect: SelectorDialect): void {
  slot.record.model = spec.base;
  if (dialect.thinking !== "field" || !spec.thinking || !dialect.thinkingField) return;
  const field = dialect.thinkingField;
  if (!nonBlank(slot.record[field])) slot.record[field] = spec.thinking;
}
