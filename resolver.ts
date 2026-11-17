/**
 * Host model and selector resolution. Pure apart from the host facades passed in:
 * no file I/O, no module state. A selector is parsed once into a domain value, then
 * every consumer (routing, `show`, `doctor`, completion) uses the same interpretation.
 *
 * A slash is ambiguous: `a/b` can mean provider `a` model `b`, or a bare model id
 * that itself contains a slash. The parser keeps both readings available through
 * `selectorRefs`; registry lookups try the provider form first, then the bare form.
 */

import {
  ADAPTERS,
  matchesSchema,
  normalizeSelector,
  schemaProps,
  THINKING_LEVELS,
} from "./adapters";
import type { SubagentAdapter, ToolInfoLike } from "./adapters";
import type { CurrentModelRef } from "./config";

// ── host-facing types ────────────────────────────────────────────

export interface ModelsFacade {
  current(): unknown;
  resolve(spec: string): unknown;
  /** omp exposes the authenticated model list; upstream pi does not. */
  list?(): unknown;
}

/** Decision 13: duck type of upstream pi's ctx.modelRegistry (absent in omp; guard each method). */
export interface ModelRegistryFacade {
  find?(provider: string, modelId: string): unknown;
  getAvailable?(): unknown;
  getAll?(): unknown;
  hasConfiguredAuth?(model: unknown): boolean;
}

export type NotifyLevel = "info" | "warning" | "error";

export interface UiFacade {
  notify(message: string, level?: NotifyLevel): void;
  /** Both hosts accept plain strings; omp also accepts option objects. */
  select?(title: string, options: readonly string[], dialogOptions?: unknown): Promise<string | undefined>;
  setStatus?(key: string, text: string | undefined): void;
}

export interface ExtensionContextLike {
  cwd: string;
  mode?: "tui" | "rpc" | "json" | "print";
  /** Provided by omp; upstream pi lacks it. Fall back to model / modelRegistry there. */
  models?: ModelsFacade;
  /** Upstream pi's ctx.model: the current model (model-shaped, narrowed by toModelRef). */
  model?: unknown;
  modelRegistry?: ModelRegistryFacade;
  ui?: UiFacade;
  /** omp and upstream pi both expose this on the extension context. */
  hasUI?: boolean;
}

/** omp's before_subagent_spawn event (upstream pi has no such event). */
export interface SubagentSpawnEvent {
  agent?: unknown;
  patterns?: unknown;
  /** Role alias the patterns came from; undefined when the caller supplied an explicit selector. */
  modelRole?: unknown;
  invocationKind?: unknown;
}

/** omp CustomToolCallEvent shape (upstream pi's tool_call event is isomorphic; only these two fields are used). */
export interface ToolCallEventLike {
  toolName?: unknown;
  input?: unknown;
}

/** The part of ExtensionAPI this package uses for adapter detection. */
export interface ToolHost {
  getAllTools?(): unknown;
}

export interface RegistrySnapshot {
  entries: unknown[] | null;
  resolved: Map<string, boolean>;
}

export type SelectorKind = "alias" | "glob" | "provider-id" | "bare" | "unknown";

export interface ParsedSelector {
  raw: string;
  /** The selector without a recognised `:level` suffix. */
  base: string;
  thinking?: string;
  kind: "alias" | "glob" | "reference";
  /** Present for a slash-containing reference: the first segment, with `id` as the rest. */
  provider?: string;
  id: string;
}

// ── model shapes ─────────────────────────────────────────────────

export function modelId(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  if ("id" in model && typeof model.id === "string") return model.id.trim();
  if ("modelId" in model && typeof model.modelId === "string") return model.modelId.trim();
  if ("model" in model && typeof model.model === "string") return model.model.trim();
  return undefined;
}

export function modelProvider(model: unknown): string {
  if (!model || typeof model !== "object") return "";
  if ("provider" in model && typeof model.provider === "string") return model.provider.trim();
  if ("providerId" in model && typeof model.providerId === "string") return model.providerId.trim();
  return "";
}

export function toModelRef(model: unknown): CurrentModelRef | undefined {
  const id = modelId(model);
  if (!id) return undefined;
  return { provider: modelProvider(model), id };
}

/** Decision 12: host-agnostic current-model lookup. omp uses ctx.models.current(); upstream pi uses ctx.model. */
export function currentModelRef(ctx: ExtensionContextLike): CurrentModelRef | undefined {
  if (ctx.models && typeof ctx.models.current === "function") {
    try {
      return toModelRef(ctx.models.current());
    } catch {
      return undefined;
    }
  }
  return toModelRef(ctx.model);
}

export function formatModelRef(ref: CurrentModelRef | undefined): string {
  if (!ref) return "(unknown)";
  return ref.provider ? `${ref.provider}/${ref.id}` : ref.id;
}

export function sameModelRef(left: CurrentModelRef, right: CurrentModelRef): boolean {
  if (left.id.toLowerCase() !== right.id.toLowerCase()) return false;
  if (!left.provider || !right.provider) return true;
  return left.provider.toLowerCase() === right.provider.toLowerCase();
}

// ── selector parsing ─────────────────────────────────────────────

/**
 * Decision 13: strip a trailing `:level` when the suffix is an upstream ThinkingLevel.
 * An unknown suffix stays part of the id. `@alias` and glob selectors are kept whole.
 */
export function parseSelector(selector: string): ParsedSelector | undefined {
  const raw = selector.trim();
  if (!raw) return undefined;
  if (raw.startsWith("@")) return { raw, base: raw, kind: "alias", id: raw };
  let base = raw;
  let thinking: string | undefined;
  const colon = base.lastIndexOf(":");
  if (colon > 0 && THINKING_LEVELS.has(base.slice(colon + 1))) {
    thinking = base.slice(colon + 1);
    base = base.slice(0, colon);
  }
  if (!base) return undefined;
  if (base.includes("*")) {
    return { raw, base, ...(thinking === undefined ? {} : { thinking }), kind: "glob", id: base };
  }
  if (base.startsWith("/")) return undefined;
  const slash = base.indexOf("/");
  if (slash > 0) {
    const id = base.slice(slash + 1);
    if (!id) return undefined;
    return {
      raw,
      base,
      ...(thinking === undefined ? {} : { thinking }),
      kind: "reference",
      provider: base.slice(0, slash),
      id,
    };
  }
  return { raw, base, ...(thinking === undefined ? {} : { thinking }), kind: "reference", id: base };
}

/** Both readings of a reference, provider form first, then the whole base as a bare id. */
export function selectorRefs(parsed: ParsedSelector): CurrentModelRef[] {
  if (parsed.kind !== "reference") return [];
  if (parsed.provider !== undefined) {
    return [
      { provider: parsed.provider, id: parsed.id },
      { provider: "", id: parsed.base },
    ];
  }
  return [{ provider: "", id: parsed.base }];
}

// ── registry lookups ─────────────────────────────────────────────

export function createRegistrySnapshot(): RegistrySnapshot {
  return { entries: null, resolved: new Map() };
}

/** One registry listing per snapshot. getAvailable() is already authenticated; the
 * getAll() fallback is filtered through hasConfiguredAuth() so every consumer sees the
 * same set. */
export function registryEntries(registry: ModelRegistryFacade, snapshot: RegistrySnapshot): unknown[] {
  if (snapshot.entries !== null) return snapshot.entries;
  let raw: unknown;
  let usedGetAll = false;
  try {
    if (typeof registry.getAvailable === "function") raw = registry.getAvailable();
    if (!Array.isArray(raw) && typeof registry.getAll === "function") {
      raw = registry.getAll();
      usedGetAll = true;
    }
  } catch {
    snapshot.entries = [];
    return snapshot.entries;
  }
  const entries = Array.isArray(raw) ? raw : [];
  snapshot.entries = usedGetAll ? entries.filter((entry) => entryAvailable(registry, entry)) : entries;
  return snapshot.entries;
}

/** A found model is usable only when the host can authenticate it. */
function entryAvailable(registry: ModelRegistryFacade, entry: unknown): boolean {
  if (typeof registry.hasConfiguredAuth !== "function") return true;
  try {
    return registry.hasConfiguredAuth(entry);
  } catch {
    return false;
  }
}

/** Scan the snapshot, comparing the raw id before reading the provider (avoids per-entry refs). */
export function hasRegistryModel(
  registry: ModelRegistryFacade,
  snapshot: RegistrySnapshot,
  provider: string | undefined,
  id: string,
): boolean {
  for (const entry of registryEntries(registry, snapshot)) {
    if (modelId(entry) !== id) continue;
    if (provider !== undefined && modelProvider(entry) !== provider) continue;
    return true;
  }
  return false;
}

/**
 * Decision 13: upstream pi has no ctx.models.resolve(); validate the selector in tiers
 * against modelRegistry:
 * 1. leading `@` is an omp-only alias → unresolvable;
 * 2. strip a `:level` suffix matching upstream ThinkingLevel, then validate the base;
 *    empty base → unresolvable;
 * 3. contains `*` is a glob → pass through; the child process resolves it via minimatch
 *    (a failure surfaces as an explicit error on that delegation);
 * 4. `provider/id` → find() decides, and the model must have configured auth; without
 *    find, scan the list;
 * 5. if the provider reading misses, try the whole base as a bare id (model ids may
 *    contain a slash).
 * Comparisons are case-sensitive on purpose: the child process resolves ids exactly, so
 * leniency here would inject selectors the child cannot resolve (unlike `main`, matched loosely).
 * The snapshot caches by the level-stripped base, so `m:low` and `m:high` share one lookup.
 */
export function piSelectorResolvable(
  selector: string,
  registry: ModelRegistryFacade,
  snapshot: RegistrySnapshot,
): boolean {
  const parsed = parseSelector(selector);
  if (!parsed) return false;
  if (parsed.kind === "alias") return false;
  if (parsed.kind === "glob") return true;
  const cached = snapshot.resolved.get(parsed.base);
  if (cached !== undefined) return cached;
  let result = false;
  if (parsed.provider !== undefined && parsed.id) {
    if (typeof registry.find === "function") {
      try {
        const found = registry.find(parsed.provider, parsed.id);
        result = Boolean(found) && entryAvailable(registry, found);
      } catch {
        result = false;
      }
    } else {
      result = hasRegistryModel(registry, snapshot, parsed.provider, parsed.id);
    }
  }
  if (!result) result = hasRegistryModel(registry, snapshot, undefined, parsed.base);
  snapshot.resolved.set(parsed.base, result);
  return result;
}

/**
 * Decision 12/13: whether the selector resolves. omp uses ctx.models.resolve(); upstream
 * uses modelRegistry. Neither present returns undefined (this host cannot pre-validate;
 * pass through for the child process to resolve).
 */
export function selectorResolvable(
  ctx: ExtensionContextLike,
  selector: string,
  snapshot?: RegistrySnapshot,
): boolean | undefined {
  if (ctx.models && typeof ctx.models.resolve === "function") {
    try {
      return Boolean(ctx.models.resolve(selector));
    } catch {
      return false;
    }
  }
  if (ctx.modelRegistry) {
    return piSelectorResolvable(selector, ctx.modelRegistry, snapshot ?? createRegistrySnapshot());
  }
  return undefined;
}

/**
 * Registry entries visible to this context: omp's authenticated list first, then the
 * upstream registry snapshot. undefined means this host cannot enumerate models.
 */
function contextEntries(
  ctx: ExtensionContextLike,
  snapshot: RegistrySnapshot,
): unknown[] | undefined {
  if (ctx.models && typeof ctx.models.list === "function") {
    if (snapshot.entries !== null) return snapshot.entries;
    try {
      const raw = ctx.models.list();
      snapshot.entries = Array.isArray(raw) ? raw : [];
      return snapshot.entries;
    } catch {
      snapshot.entries = [];
      return snapshot.entries;
    }
  }
  if (ctx.modelRegistry) return registryEntries(ctx.modelRegistry, snapshot);
  return undefined;
}

/** Model ids for completion, both provider/id and bare forms, in registry order. */
export function availableModelIds(ctx: ExtensionContextLike): string[] {
  const entries = contextEntries(ctx, createRegistrySnapshot());
  if (!entries) return [];
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = modelId(entry);
    if (!id) continue;
    const provider = modelProvider(entry);
    if (provider) ids.add(`${provider}/${id}`);
    ids.add(id);
  }
  return [...ids];
}

/**
 * Whether a reference is provider/id, a bare id, or unknown. A slash-containing id
 * is classified by the registry, so a bare id such as `meta-llama/Llama-3` stays bare
 * when no provider named `meta-llama` exposes a model named `Llama-3`.
 */
export function selectorKind(
  ctx: ExtensionContextLike,
  selector: string,
  snapshot: RegistrySnapshot = createRegistrySnapshot(),
): SelectorKind {
  const parsed = parseSelector(selector);
  if (!parsed) return "unknown";
  if (parsed.kind === "alias") return "alias";
  if (parsed.kind === "glob") return "glob";
  const entries = contextEntries(ctx, snapshot);
  if (entries) {
    if (
      parsed.provider !== undefined &&
      parsed.id !== "" &&
      entries.some((entry) => modelId(entry) === parsed.id && modelProvider(entry) === parsed.provider)
    ) {
      return "provider-id";
    }
    if (entries.some((entry) => modelId(entry) === parsed.base)) return "bare";
    return "unknown";
  }
  if (parsed.provider === undefined) return "bare";
  // Without enumeration we cannot confirm provider/id: the generic resolver also
  // accepts bare ids, so a slash-containing bare id would masquerade as provider/id.
  // Callers that require a confirmed provider/id must treat "unknown" as a rejection.
  return "unknown";
}

/**
 * nicobailon accepts a bare id when exactly one provider exposes it, or when the
 * spawning session's provider is one of the candidates. omp exposes the authenticated
 * list at ctx.models.list(); upstream pi exposes the registry's auth-filtered snapshot.
 * undefined means this host cannot tell. A selector that resolves as provider/id is not
 * a bare id.
 */
export function bareSelectorUnique(
  ctx: ExtensionContextLike,
  selector: string,
  snapshot: RegistrySnapshot,
  modelRef: CurrentModelRef | undefined,
): boolean | undefined {
  const parsed = parseSelector(selector);
  if (!parsed || parsed.kind !== "reference") return undefined;
  const entries = contextEntries(ctx, snapshot);
  if (!entries) return undefined;
  if (
    parsed.provider !== undefined &&
    parsed.id !== "" &&
    entries.some((entry) => modelId(entry) === parsed.id && modelProvider(entry) === parsed.provider)
  ) {
    return undefined;
  }
  const providers = new Set<string>();
  for (const entry of entries) {
    if (modelId(entry) === parsed.base) providers.add(modelProvider(entry));
  }
  if (providers.size === 0) return undefined;
  if (modelRef && providers.has(modelRef.provider)) return true;
  return providers.size === 1;
}

// ── plugin adapters ──────────────────────────────────────────────

/** Decision 15: read the registered tool schemas for adapter detection. */
export function readToolInfos(pi: ToolHost | undefined): readonly ToolInfoLike[] | undefined {
  if (!pi || typeof pi.getAllTools !== "function") return undefined;
  try {
    const raw = pi.getAllTools();
    if (!Array.isArray(raw)) return undefined;
    const infos: ToolInfoLike[] = [];
    for (const entry of raw) {
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) infos.push(entry);
    }
    return infos;
  } catch {
    return undefined;
  }
}

/** undefined means the host cannot list tools; an empty array means no supported plugin is installed. */
export function installedAdapters(
  tools: readonly ToolInfoLike[] | undefined,
): SubagentAdapter[] | undefined {
  if (!tools) return undefined;
  return ADAPTERS.filter((adapter) =>
    tools.some(
      (info) =>
        typeof info.name === "string" &&
        adapter.toolNames.includes(info.name) &&
        matchesSchema(adapter, schemaProps(info)),
    ),
  );
}

/** Whether this adapter can express the selector in its dialect and resolve its bare-id rule. */
export function adapterAcceptsSelector(
  ctx: ExtensionContextLike,
  selector: string,
  adapter: SubagentAdapter,
  snapshot: RegistrySnapshot,
  modelRef?: CurrentModelRef,
): boolean {
  const spec = normalizeSelector(selector, adapter.dialect);
  if (!spec) return false;
  if (!adapter.dialect.allowBareId && selectorKind(ctx, spec.base, snapshot) !== "provider-id") {
    return false;
  }
  if (adapter.dialect.uniqueBareId) {
    const unique = bareSelectorUnique(
      ctx,
      spec.base,
      snapshot,
      modelRef ?? currentModelRef(ctx),
    );
    if (unique === false) return false;
  }
  return true;
}
