/**
 * pi-model-sync — routes subagent models from the spawning session's current model.
 * Dual host: omp / upstream pi (decision 12).
 *
 * Two interception paths:
 * 1. omp native before_subagent_spawn: fires in the spawning session (nested spawns
 *    included), where ctx.models.current() is that session's model; on a resolvable
 *    profile hit, the child's model is rewritten (original patterns stay as the retry
 *    fallback chain). Upstream pi lacks this event; a failed registration is skipped.
 * 2. tool_call: intercepts the tools of supported subagent plugins. The registered tool
 *    schema and the call shape pick an adapter (decision 15); when a call carries no
 *    model, a per-call model is injected from the same profile table. An explicit
 *    per-call model always wins and is never overwritten (decision 11).
 *
 * Everything else passes through untouched. Startup is fully silent (decision 6).
 *
 * Decisions referenced by number in comments:
 * 1. Route new subagents from the spawning session's current model.
 * 2. Nested spawns use the spawning session's model, not the root's.
 * 3. Profile matching is case-insensitive, first match wins, `*` is an explicit glob.
 * 4. Unresolvable selectors fall back to default routing with a one-time TUI warning.
 * 5. Writes target the global layer by default; `--project` targets the project layer.
 * 6. Startup is silent.
 * 7. Original model patterns remain as retry fallbacks after the routed selector.
 * 8. An existing project file wholly replaces the global file.
 * 9. Command output and errors are English.
 * 10. The spawn path never throws.
 * 11. An explicit per-call plugin model is never overwritten.
 * 12. Dual-host support: omp via ctx.models, upstream pi via ctx.model/modelRegistry.
 * 13. Upstream selector tiers: @alias, :level, glob, provider/id, bare id.
 * 14. Resume and management calls are never given a model.
 * 15. Subagent plugins are detected from their registered tool schema, with the call
 *     shape as the fallback when the host cannot list tools.
 * 16. pi-model-sync never writes another plugin's settings file.
 */
// Type-only and erased at runtime; the upstream package name keeps npm/pi-gallery tooling happy,
// while omp supplies the same ambient ExtensionAPI surface under either name.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ADAPTER_TOOL_NAMES,
  applyModelSpec,
  normalizeSelector,
  selectAdapter,
  THINKING_LEVELS,
} from "./adapters";
import type { SubagentAdapter, ToolInfoLike } from "./adapters";
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
} from "./config";
import type { CurrentModelRef, EffectiveConfig, ModelSyncConfig, PresetMap, Profile } from "./config";

// ── host-facing types ────────────────────────────────────────────

interface ModelsFacade {
  current(): unknown;
  resolve(spec: string): unknown;
}

/** Decision 13: duck type of upstream pi's ctx.modelRegistry (absent in omp; guard each method). */
interface ModelRegistryFacade {
  find?(provider: string, modelId: string): unknown;
  getAvailable?(): unknown;
  getAll?(): unknown;
}

type NotifyLevel = "info" | "warning" | "error";

interface UiFacade {
  notify(message: string, level?: NotifyLevel): void;
}

interface ExtensionContextLike {
  cwd: string;
  mode?: "tui" | "rpc" | "json" | "print";
  /** Provided by omp; upstream pi lacks it — fall back to model / modelRegistry there. */
  models?: ModelsFacade;
  /** Upstream pi's ctx.model: the current model (model-shaped, narrowed by toModelRef). */
  model?: unknown;
  /** Upstream pi's ctx.modelRegistry. */
  modelRegistry?: ModelRegistryFacade;
  ui?: UiFacade;
}

/** Host autocomplete item shape; kept local so only ExtensionAPI is imported from the host. */
interface ArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}

/** omp CustomToolCallEvent shape (upstream pi's tool_call event is isomorphic; only these two fields are used). */
interface ToolCallEventLike {
  toolName?: unknown;
  input?: unknown;
}

interface SubagentSpawnEvent {
  agent?: unknown;
  patterns?: unknown;
}

interface SpawnRoutingResult {
  model: string[];
  note: string;
}

interface ToolCallRoutingResult {
  input: Record<string, unknown>;
}

interface RegistrySnapshot {
  entries: unknown[] | null;
  resolved: Map<string, boolean>;
}

// ── model adapters ───────────────────────────────────────────────

function modelId(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  if ("id" in model && typeof model.id === "string") return model.id.trim();
  if ("modelId" in model && typeof model.modelId === "string") return model.modelId.trim();
  if ("model" in model && typeof model.model === "string") return model.model.trim();
  return undefined;
}

function modelProvider(model: unknown): string {
  if (!model || typeof model !== "object") return "";
  if ("provider" in model && typeof model.provider === "string") return model.provider.trim();
  if ("providerId" in model && typeof model.providerId === "string") return model.providerId.trim();
  return "";
}

function toModelRef(model: unknown): CurrentModelRef | undefined {
  const id = modelId(model);
  if (!id) return undefined;
  return { provider: modelProvider(model), id };
}

/** Decision 12: host-agnostic current-model lookup — omp via ctx.models.current(); upstream pi via ctx.model. */
function currentModelRef(ctx: ExtensionContextLike): CurrentModelRef | undefined {
  if (ctx.models && typeof ctx.models.current === "function") {
    try {
      return toModelRef(ctx.models.current());
    } catch {
      return undefined;
    }
  }
  return toModelRef(ctx.model);
}

function createRegistrySnapshot(): RegistrySnapshot {
  return { entries: null, resolved: new Map() };
}

/** One registry listing per snapshot: getAvailable() wins, getAll() is the fallback. */
function registryEntries(registry: ModelRegistryFacade, snapshot: RegistrySnapshot): unknown[] {
  if (snapshot.entries !== null) return snapshot.entries;
  let raw: unknown;
  try {
    if (typeof registry.getAvailable === "function") raw = registry.getAvailable();
    if (!Array.isArray(raw) && typeof registry.getAll === "function") raw = registry.getAll();
  } catch {
    snapshot.entries = [];
    return snapshot.entries;
  }
  snapshot.entries = Array.isArray(raw) ? raw : [];
  return snapshot.entries;
}

/** Scan the snapshot, comparing the raw id before reading the provider (avoids per-entry refs). */
function hasRegistryModel(
  registry: ModelRegistryFacade,
  snapshot: RegistrySnapshot,
  provider: string | undefined,
  id: string,
): boolean {
  for (const entry of registryEntries(registry, snapshot)) {
    if (modelId(entry) !== id) continue;
    if (provider === undefined || modelProvider(entry) === provider) return true;
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
 * 4. `provider/id` → find() decides; without find, scan the list;
 * 5. bare id → scan the list for a matching id.
 * Comparisons are case-sensitive on purpose: the child process resolves ids exactly, so
 * leniency here would inject selectors the child cannot resolve (unlike `main`, matched loosely).
 * The snapshot caches by the level-stripped base, so `m:low` and `m:high` share one lookup.
 */
function piSelectorResolvable(
  selector: string,
  registry: ModelRegistryFacade,
  snapshot: RegistrySnapshot,
): boolean {
  if (selector.startsWith("@")) return false;
  let base = selector;
  const colon = base.lastIndexOf(":");
  if (colon > 0 && THINKING_LEVELS.has(base.slice(colon + 1))) {
    base = base.slice(0, colon);
  }
  if (!base) return false;
  if (base.includes("*")) return true;
  const cached = snapshot.resolved.get(base);
  if (cached !== undefined) return cached;
  let result: boolean;
  const slash = base.indexOf("/");
  if (slash === 0) {
    result = false;
  } else if (slash > 0) {
    const provider = base.slice(0, slash);
    const id = base.slice(slash + 1);
    if (!id) {
      result = false;
    } else if (typeof registry.find === "function") {
      try {
        result = Boolean(registry.find(provider, id));
      } catch {
        result = false;
      }
    } else {
      result = hasRegistryModel(registry, snapshot, provider, id);
    }
  } else {
    result = hasRegistryModel(registry, snapshot, undefined, base);
  }
  snapshot.resolved.set(base, result);
  return result;
}

/**
 * Decision 12/13: whether the selector resolves — omp via ctx.models.resolve(); upstream
 * via modelRegistry; neither present → undefined (this host cannot pre-validate; pass
 * through for the child process to resolve).
 */
function selectorResolvable(
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
 * nicobailon accepts a bare id when exactly one provider exposes it, or when the
 * spawning session's provider is one of the candidates. Upstream pi exposes the full
 * registry, so count the providers. omp's resolve() picks one model and hides the
 * rest, so trust it there. undefined → this host cannot tell.
 */
function bareSelectorUnique(
  ctx: ExtensionContextLike,
  selector: string,
  snapshot: RegistrySnapshot,
  modelRef: CurrentModelRef | undefined,
): boolean | undefined {
  let base = selector;
  const colon = base.lastIndexOf(":");
  if (colon > 0 && THINKING_LEVELS.has(base.slice(colon + 1))) base = base.slice(0, colon);
  if (!base || base.startsWith("@") || base.includes("*") || base.includes("/")) return undefined;
  const registry = ctx.modelRegistry;
  if (!registry) return undefined;
  if (typeof registry.getAvailable !== "function" && typeof registry.getAll !== "function") {
    return undefined;
  }
  const providers = new Set<string>();
  for (const entry of registryEntries(registry, snapshot)) {
    if (modelId(entry) === base) providers.add(modelProvider(entry));
  }
  if (providers.size === 0) return undefined;
  if (modelRef && providers.has(modelRef.provider)) return true;
  return providers.size === 1;
}

// ── spawn and tool_call routing (decisions 1, 2, 4, 7, 10, 11) ──

/** Selectors already warned about as unresolvable (once per selector). */
const warnedSelectors = new Set<string>();

/** event.agent shape isn't documented: a string or { name }; falls back to "task" when both fail. */
function extractAgentName(event: SubagentSpawnEvent): string {
  const agent = event.agent;
  if (typeof agent === "string" && agent.trim()) return agent.trim();
  if (agent && typeof agent === "object" && "name" in agent) {
    const name = agent.name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return "task";
}

function summarizeSubagents(subagents: Profile["subagents"]): string {
  if (typeof subagents === "string") return subagents;
  return Object.entries(subagents)
    .map(([agent, selector]) => `${agent}=${selector}`)
    .join(", ");
}

function notify(ctx: ExtensionContextLike, message: string, level: NotifyLevel = "info"): void {
  if (ctx.ui && typeof ctx.ui.notify === "function") {
    ctx.ui.notify(message, level);
  }
}

/** Decision 4 helper: one-time TUI warning for a selector that failed to resolve; the
 * warned set is bounded so long sessions stay lean. */
function warnUnresolvableOnce(ctx: ExtensionContextLike, selector: string, tail: string): void {
  if (ctx.mode !== "tui" || warnedSelectors.has(selector)) return;
  if (warnedSelectors.size >= 256) warnedSelectors.clear();
  warnedSelectors.add(selector);
  notify(ctx, `pi-model-sync: selector "${selector}" could not be resolved to an available model; ${tail}`, "warning");
}

function handleBeforeSubagentSpawn(
  event: SubagentSpawnEvent,
  ctx: ExtensionContextLike,
): SpawnRoutingResult | undefined {
  try {
    // Cheap guards first (hot path): an unrecognizable session model can never match
    // a profile, so the config read is skipped entirely.
    const modelRef = currentModelRef(ctx);
    if (!modelRef) return undefined;
    const profile = findProfile(readConfig(ctx.cwd), modelRef);
    if (!profile) return undefined;
    const agentName = extractAgentName(event);
    const selector = pickSubagentSelector(profile, agentName);
    if (!selector) return undefined;
    const ok = selectorResolvable(ctx, selector);
    if (ok === false) {
      // Decision 4: unresolvable selectors fall back to default routing, warned once in the TUI.
      warnUnresolvableOnce(ctx, selector, "using default routing for this spawn");
      return undefined;
    }
    const rawPatterns = event.patterns;
    const basePatterns = Array.isArray(rawPatterns)
      ? rawPatterns.filter((pattern): pattern is string => typeof pattern === "string")
      : typeof rawPatterns === "string"
        ? [rawPatterns]
        : [];
    const patterns = basePatterns.filter((pattern) => pattern !== selector);
    return {
      model: [selector, ...patterns],
      note: `pi-model-sync: ${agentName} → ${selector} (main: ${profile.main})`,
    };
  } catch {
    return undefined; // decision 10: the spawn-interception path must never throw
  }
}

/**
 * Decision 15: read the registered tool schemas for adapter detection. A host without
 * getAllTools(), or one that throws, falls back to call-shape detection.
 */
function readToolInfos(pi: ExtensionAPI | undefined): readonly ToolInfoLike[] | undefined {
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

/** Adapter conflicts are a setup problem, not a per-call one: warn once per tool + set. */
const warnedAdapterConflicts = new Set<string>();

function warnAdapterConflictOnce(
  ctx: ExtensionContextLike,
  toolName: string,
  adapters: readonly SubagentAdapter[],
): void {
  if (ctx.mode !== "tui") return;
  const ids = adapters.map((adapter) => adapter.id);
  const key = `${toolName}:${[...ids].sort().join(",")}`;
  if (warnedAdapterConflicts.has(key)) return;
  if (warnedAdapterConflicts.size >= 64) warnedAdapterConflicts.clear();
  warnedAdapterConflicts.add(key);
  notify(
    ctx,
    `pi-model-sync: tool "${toolName}" matches multiple subagent adapters (${ids.join(
      ", ",
    )}); skipping model injection`,
    "warning",
  );
}

function handleToolCall(
  event: ToolCallEventLike,
  ctx: ExtensionContextLike,
  pi?: ExtensionAPI,
): ToolCallRoutingResult | undefined {
  try {
    if (typeof event.toolName !== "string" || !ADAPTER_TOOL_NAMES.has(event.toolName)) {
      return undefined;
    }
    const input = event.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    const inputRecord = input as Record<string, unknown>;
    // Decision 15: schema first, call shape second. An explicit model, a resume, or a
    // management call collects no slot, so the config read never happens for it.
    const selection = selectAdapter(event.toolName, inputRecord, readToolInfos(pi));
    if (selection.kind === "ambiguous") {
      warnAdapterConflictOnce(ctx, event.toolName, selection.adapters);
      return undefined;
    }
    if (selection.kind === "none") return undefined;
    const modelRef = currentModelRef(ctx);
    if (!modelRef) return undefined;
    const profile = findProfile(readConfig(ctx.cwd), modelRef);
    if (!profile) return undefined;
    let changed = false;
    // Per-event memo (dynamic insert → Map): a batch often repeats the same agent or
    // "*" default; validate each unique selector once (registry scans are not free upstream).
    const resolutionCache = new Map<string, boolean | undefined>();
    let registrySnapshot: RegistrySnapshot | undefined;
    for (const slot of selection.slots) {
      const selector = pickSubagentSelector(profile, slot.agentName);
      if (!selector) continue;
      const spec = normalizeSelector(selector, selection.adapter.dialect);
      if (!spec) {
        warnUnresolvableOnce(
          ctx,
          selector,
          `cannot route ${selection.adapter.label}; using its default model`,
        );
        continue;
      }
      if (selection.adapter.dialect.uniqueBareId) {
        registrySnapshot ??= createRegistrySnapshot();
        if (bareSelectorUnique(ctx, spec.base, registrySnapshot, modelRef) === false) {
          warnUnresolvableOnce(
            ctx,
            selector,
            "the bare model id matches more than one provider; use provider/id",
          );
          continue;
        }
      }
      if (!resolutionCache.has(spec.base)) {
        registrySnapshot ??= createRegistrySnapshot();
        resolutionCache.set(spec.base, selectorResolvable(ctx, spec.base, registrySnapshot));
      }
      if (resolutionCache.get(spec.base) === false) {
        warnUnresolvableOnce(ctx, selector, "using the default model for this subagent delegation");
        continue;
      }
      applyModelSpec(slot, spec, selection.adapter.dialect);
      changed = true;
    }
    return changed ? { input: inputRecord } : undefined;
  } catch {
    return undefined; // never throws — the same never-throw invariant as the native path
  }
}

// ── command text and completion ─────────────────────────────────

const USAGE = [
  "pi-model-sync commands:",
  "  /model-sync [list]                      Show the active layer, active preset, and all profiles",
  "  /model-sync show [model] [agent]        Show the current or requested model, matched profile, and selector status",
  "  /model-sync add <main> <model>          Add/update a profile in the active preset (all subagents use <model>)",
  "  /model-sync set <main> <agent> <model>  Set a model for one agent (use * for the profile default)",
  "  /model-sync remove <main> [agent]       Remove a whole profile or one agent entry",
  "  /model-sync move <main> <top|bottom|up|down>  Reorder a profile in the active preset",
  "  /model-sync preset list                 List presets in the active layer",
  "  /model-sync preset create <name>        Create an empty inactive preset",
  "  /model-sync preset copy <source> <name> Deep-copy a preset without switching to it",
  "  /model-sync preset rename <old> <new>   Rename a preset without changing its profiles",
  "  /model-sync preset use <name>           Select the active preset",
  "  /model-sync preset remove <name>        Remove an inactive preset",
  "Writes use the global file by default. Add --project to target <cwd>/.omp/pi-model-sync.json (or <cwd>/.pi/pi-model-sync.json when the .omp file is absent and the .pi file exists).",
].join("\n");

const PRESET_USAGE = [
  "pi-model-sync preset commands:",
  "  /model-sync preset list",
  "  /model-sync preset create <name>",
  "  /model-sync preset copy <source> <name>",
  "  /model-sync preset rename <old> <new>",
  "  /model-sync preset use <name>",
  "  /model-sync preset remove <name>",
].join("\n");

const TOP_LEVEL_COMPLETIONS: ArgumentCompletion[] = [
  { value: "list", label: "list", description: "Show the active layer, active preset, and profiles" },
  { value: "show ", label: "show", description: "Show the current or requested model, matched profile, and selector status" },
  { value: "add ", label: "add", description: "Add/update a profile in the active preset" },
  { value: "set ", label: "set", description: "Set a model for one agent in the active preset" },
  { value: "remove ", label: "remove", description: "Remove a profile or agent entry from the active preset" },
  { value: "move ", label: "move", description: "Reorder a profile in the active preset" },
  { value: "preset ", label: "preset", description: "List, create, copy, rename, use, or remove presets" },
  { value: "help", label: "help", description: "Show the top-level usage" },
];

const PRESET_COMPLETIONS: ArgumentCompletion[] = [
  { value: "preset list", label: "list", description: "List presets in the active layer" },
  { value: "preset create ", label: "create", description: "Create an empty inactive preset" },
  { value: "preset copy ", label: "copy", description: "Deep-copy a preset without switching" },
  { value: "preset rename ", label: "rename", description: "Rename a preset without changing its profiles" },
  { value: "preset use ", label: "use", description: "Select the active preset" },
  { value: "preset remove ", label: "remove", description: "Remove an inactive preset" },
  { value: "preset help", label: "help", description: "Show the preset usage" },
];

const POSITION_DESCRIPTIONS: Record<string, string> = {
  top: "Move to the top",
  bottom: "Move to the bottom",
  up: "Move up one position",
  down: "Move down one position",
};

interface CompletionContext {
  current: string;
  beforeCurrent: string;
  commandTokens: string[];
  projectFlagInTokens: boolean;
  useProject: boolean;
}

function parseCompletionContext(argumentPrefix: string): CompletionContext {
  const tokens = argumentPrefix.trim().split(/\s+/).filter((token) => token.length > 0);
  const hasTrailingSpace = /\s$/.test(argumentPrefix);
  const current = hasTrailingSpace ? "" : tokens.pop() ?? "";
  const projectFlagInTokens = tokens.includes("--project");
  const useProject = projectFlagInTokens || current === "--project";
  const commandTokens = tokens.filter((token) => token !== "--project");
  const beforeCurrent = argumentPrefix.slice(0, argumentPrefix.length - current.length);
  return { current, beforeCurrent, commandTokens, projectFlagInTokens, useProject };
}

/** Append a typed --project flag, keeping any trailing space for the next argument. */
function withProject(value: string, context: CompletionContext): string {
  if (!context.useProject) return value;
  const trailing = value.endsWith(" ") ? " " : "";
  return `${value.trimEnd()} --project${trailing}`;
}

/** The host completion callback has no ctx; process.cwd() is the only cwd available. */
function completionTarget(useProject: boolean): string {
  const cwd = process.cwd();
  return useProject ? getProjectConfigPath(cwd) : getGlobalConfigPath(cwd);
}

function presetCompletionItems(
  target: string,
  action: string,
  current: string,
  context: CompletionContext,
): ArgumentCompletion[] | null {
  const layer = readLayer(target);
  if (!layer.exists || layer.error) return null;
  const active = isNamedConfig(layer.config) ? layer.config.activePreset : "default";
  const items: ArgumentCompletion[] = [];
  for (const name of presetNames(layer.config)) {
    if (!name.startsWith(current)) continue;
    let description = "preset";
    if (name === active) {
      description =
        action === "use"
          ? "already active"
          : action === "remove"
            ? "active; switch away before removing"
            : "active preset";
    }
    const needsArgument = action === "copy" || action === "rename";
    items.push({
      value: withProject(`preset ${action} ${name}${needsArgument ? " " : ""}`, context),
      label: name,
      description,
    });
  }
  return items.length > 0 ? items : null;
}

function profileCompletionItems(
  sub: string,
  rest: string[],
  current: string,
  context: CompletionContext,
): ArgumentCompletion[] | null {
  const layer = readLayer(completionTarget(context.useProject));
  if (!layer.exists || layer.error) return null;
  const effective = projectActiveProfiles(layer.config);
  if (effective.warning || !effective.activePreset) return null;
  if (rest.length === 0) {
    const prefix = current.toLowerCase();
    const items = effective.profiles
      .filter((profile) => profile.main.toLowerCase().startsWith(prefix))
      .map((profile) => ({
        value: withProject(`${sub} ${profile.main} `, context),
        label: profile.main,
        description: summarizeSubagents(profile.subagents),
      }));
    return items.length > 0 ? items : null;
  }
  if (sub === "move" && rest.length === 1) {
    const items = Object.entries(POSITION_DESCRIPTIONS)
      .filter(([position]) => position.startsWith(current))
      .map(([position, description]) => ({
        value: withProject(`move ${rest[0]} ${position}`, context),
        label: position,
        description,
      }));
    return items.length > 0 ? items : null;
  }
  if ((sub === "set" || sub === "remove") && rest.length === 1) {
    const main = rest[0];
    if (!main) return null;
    const profile = effective.profiles.find((item) => item.main.toLowerCase() === main.toLowerCase());
    if (!profile) return null;
    const entries =
      typeof profile.subagents === "string"
        ? sub === "set"
          ? [["*", profile.subagents] as const]
          : []
        : Object.entries(profile.subagents);
    const items = entries
      .filter(([agent]) => agent.startsWith(current))
      .map(([agent, selector]) => ({
        value: withProject(`${sub} ${profile.main} ${agent}${sub === "set" ? " " : ""}`, context),
        label: agent,
        description: agent === "*" ? `profile default → ${selector}` : `→ ${selector}`,
      }));
    return items.length > 0 ? items : null;
  }
  return null;
}

/** Never throws; returns null when the prefix is unknown or malformed. */
function modelSyncArgumentCompletions(argumentPrefix: string): ArgumentCompletion[] | null {
  try {
    const context = parseCompletionContext(argumentPrefix);
    const { current, beforeCurrent, commandTokens, projectFlagInTokens } = context;
    if (current.startsWith("-")) {
      if (projectFlagInTokens || !"--project".startsWith(current)) return null;
      return [{ value: `${beforeCurrent}--project`, label: "--project", description: "Target the project config" }];
    }
    const [sub, ...rest] = commandTokens;
    if (!sub) {
      const filtered = TOP_LEVEL_COMPLETIONS.filter((item) => item.label.startsWith(current));
      return filtered.length > 0
        ? filtered.map((item) => ({ ...item, value: withProject(item.value, context) }))
        : null;
    }
    if (sub === "preset") {
      const [action, ...actionArgs] = rest;
      if (!action) {
        const filtered = PRESET_COMPLETIONS.filter((item) => item.label.startsWith(current));
        return filtered.length > 0
          ? filtered.map((item) => ({ ...item, value: withProject(item.value, context) }))
          : null;
      }
      if (action !== "use" && action !== "remove" && action !== "copy" && action !== "rename") return null;
      if (actionArgs.length > 0) return null;
      return presetCompletionItems(completionTarget(context.useProject), action, current, context);
    }
    if (sub === "add" || sub === "set" || sub === "remove" || sub === "move") {
      return profileCompletionItems(sub, rest, current, context);
    }
    return null;
  } catch {
    return null;
  }
}

// ── command dispatch (decisions 5, 9) ───────────────────────────

async function commandHandler(argsString: string, ctx: ExtensionContextLike): Promise<void> {
  try {
    handleCommand(String(argsString ?? ""), ctx);
  } catch (err) {
    notify(ctx, `pi-model-sync: command failed: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

function handleCommand(argsString: string, ctx: ExtensionContextLike): void {
  const tokens = argsString.trim().split(/\s+/).filter((token) => token.length > 0);
  const useProject = tokens.includes("--project");
  const args = tokens.filter((token) => token !== "--project");
  const [sub, ...rest] = args;
  const target = useProject ? getProjectConfigPath(ctx.cwd) : getGlobalConfigPath(ctx.cwd);

  switch (sub) {
    case undefined:
    case "":
    case "list":
      if (rest.length > 0) {
        notify(ctx, `Unexpected argument for list: ${rest[0]}\n${USAGE}`, "warning");
        return;
      }
      cmdList(ctx);
      return;
    case "show": {
      if (rest.length > 2) {
        notify(ctx, `Usage: /model-sync show [model] [agent]\n${USAGE}`, "warning");
        return;
      }
      const [modelArg, agentArg] = rest;
      cmdShow(ctx, modelArg, agentArg);
      return;
    }
    case "add": {
      const [main, model] = rest;
      if (rest.length !== 2 || !main || !model) {
        notify(ctx, "Usage: /model-sync add <main> <model>", "warning");
        return;
      }
      cmdAdd(ctx, target, main, model);
      return;
    }
    case "set": {
      const [main, agent, model] = rest;
      if (rest.length !== 3 || !main || !agent || !model) {
        notify(ctx, "Usage: /model-sync set <main> <agent> <model>", "warning");
        return;
      }
      cmdSet(ctx, target, main, agent, model);
      return;
    }
    case "remove": {
      const [main, agent] = rest;
      if (rest.length < 1 || rest.length > 2 || !main) {
        notify(ctx, "Usage: /model-sync remove <main> [agent]", "warning");
        return;
      }
      cmdRemove(ctx, target, main, agent);
      return;
    }
    case "move": {
      const [main, position] = rest;
      if (rest.length !== 2 || !main || !position) {
        notify(ctx, "Usage: /model-sync move <main> <top|bottom|up|down>", "warning");
        return;
      }
      cmdMove(ctx, target, main, position);
      return;
    }
    case "preset":
      handlePresetCommand(ctx, target, rest);
      return;
    case "help":
    case "--help":
    case "-h":
      if (rest.length > 0) {
        notify(ctx, `Unexpected argument for help: ${rest[0]}\n${USAGE}`, "warning");
        return;
      }
      notify(ctx, USAGE);
      return;
    default:
      notify(ctx, USAGE);
  }
}

function handlePresetCommand(ctx: ExtensionContextLike, target: string, args: string[]): void {
  const [action, ...presetArgs] = args;
  if (!action) {
    notify(ctx, PRESET_USAGE);
    return;
  }
  switch (action) {
    case "list":
      if (presetArgs.length > 0) {
        notify(ctx, `Unexpected argument for preset list: ${presetArgs[0]}\n${PRESET_USAGE}`, "warning");
        return;
      }
      cmdPresetList(ctx);
      return;
    case "create": {
      const [name] = presetArgs;
      if (presetArgs.length !== 1 || !name) {
        notify(ctx, "Usage: /model-sync preset create <name>", "warning");
        return;
      }
      cmdPresetCreate(ctx, target, name);
      return;
    }
    case "copy": {
      const [source, name] = presetArgs;
      if (presetArgs.length !== 2 || !source || !name) {
        notify(ctx, "Usage: /model-sync preset copy <source> <name>", "warning");
        return;
      }
      cmdPresetCopy(ctx, target, source, name);
      return;
    }
    case "rename": {
      const [oldName, newName] = presetArgs;
      if (presetArgs.length !== 2 || !oldName || !newName) {
        notify(ctx, "Usage: /model-sync preset rename <old> <new>", "warning");
        return;
      }
      cmdPresetRename(ctx, target, oldName, newName);
      return;
    }
    case "use": {
      const [name] = presetArgs;
      if (presetArgs.length !== 1 || !name) {
        notify(ctx, "Usage: /model-sync preset use <name>", "warning");
        return;
      }
      cmdPresetUse(ctx, target, name);
      return;
    }
    case "remove": {
      const [name] = presetArgs;
      if (presetArgs.length !== 1 || !name) {
        notify(ctx, "Usage: /model-sync preset remove <name>", "warning");
        return;
      }
      cmdPresetRemove(ctx, target, name);
      return;
    }
    case "help":
    case "--help":
    case "-h":
      if (presetArgs.length > 0) {
        notify(ctx, `Unexpected argument for preset help: ${presetArgs[0]}\n${PRESET_USAGE}`, "warning");
        return;
      }
      notify(ctx, PRESET_USAGE);
      return;
    default:
      notify(ctx, `Unknown preset command: ${action}\n${PRESET_USAGE}`, "warning");
  }
}

// ── write helpers ───────────────────────────────────────────────

/** Save, then warn when a project layer is shadowing the global file that was just written. */
function saveConfig(
  ctx: ExtensionContextLike,
  target: string,
  config: ModelSyncConfig,
  message: string,
): void {
  writeConfig(target, config);
  const active = resolveActiveLayer(ctx.cwd);
  const shadow =
    active.layer === "project" && target !== active.path
      ? `\nNote: the project config (${active.path}) overrides the global config. Add --project to edit it.`
      : "";
  notify(ctx, `${message}${shadow}`);
}

/** Read target for writing; refuse a corrupt existing file and surface entries a rewrite would drop. */
function loadForWrite(ctx: ExtensionContextLike, target: string): ModelSyncConfig | null {
  const layer = readLayer(target);
  if (layer.error) {
    notify(ctx, `pi-model-sync: ${layer.error}\nRepair or delete this file before running a write command.`, "error");
    return null;
  }
  if (layer.warnings.length > 0) {
    notify(
      ctx,
      `pi-model-sync: config warnings:\n${layer.warnings.join("\n")}\nThese entries will be dropped when the file is rewritten.`,
      "warning",
    );
  }
  // Full-document clone: every preset and every nested subagent map stays isolated
  // from the shared cache, not just the active preset.
  return cloneConfig(layer.config);
}

function availablePresetsHint(config: ModelSyncConfig): string {
  const names = presetNames(config);
  if (names.length === 0) return "No presets yet (/model-sync preset create <name>).";
  return `Available presets: ${names.join(", ")}. Run /model-sync preset use <name> to select one.`;
}

/** Resolve the active preset on a cloned document; a missing/dangling selection fails closed. */
function loadActiveForWrite(
  ctx: ExtensionContextLike,
  target: string,
): { config: ModelSyncConfig; profiles: Profile[] } | null {
  const config = loadForWrite(ctx, target);
  if (!config) return null;
  const effective = projectActiveProfiles(config);
  if (effective.warning || !effective.activePreset) {
    const warning = effective.warning ?? "No active preset is selected; no profiles are active.";
    notify(
      ctx,
      `pi-model-sync: ${warning}\n${availablePresetsHint(config)}\nNo changes were written (target: ${target}).`,
      "warning",
    );
    return null;
  }
  return { config, profiles: effective.profiles };
}

function findProfileIndexByMain(profiles: Profile[], main: string): number {
  const mainLower = main.toLowerCase();
  return profiles.findIndex((profile) => profile.main.toLowerCase() === mainLower);
}

/** Warn when an appended literal rule would be shadowed by an earlier matching profile.
 * A bare id has no provider, so test it against each provider named by an earlier profile. */
function shadowWarning(profiles: Profile[], main: string): string {
  if (main.includes("*")) return "";
  const slash = main.indexOf("/");
  const refs: CurrentModelRef[] =
    slash > 0
      ? [{ provider: main.slice(0, slash), id: main.slice(slash + 1) }]
      : [{ provider: "", id: main }];
  if (slash < 0) {
    for (const profile of profiles) {
      const profileSlash = profile.main.indexOf("/");
      if (profileSlash <= 0) continue;
      const provider = profile.main.slice(0, profileSlash);
      if (provider.includes("*")) continue;
      refs.push({ provider, id: main });
    }
  }
  const shadow = refs.map((ref) => findProfile({ profiles }, ref)).find((hit) => hit !== undefined);
  return shadow ? `\nNote: profile "${shadow.main}" appears earlier and may match this model first.` : "";
}

// ── profile commands ────────────────────────────────────────────

function cmdAdd(ctx: ExtensionContextLike, target: string, main: string, model: string): void {
  const loaded = loadActiveForWrite(ctx, target);
  if (!loaded) return;
  const { config, profiles } = loaded;
  const index = findProfileIndexByMain(profiles, main);
  let note = "";
  if (index >= 0) {
    const existing = profiles[index];
    if (!existing) return;
    const keys = typeof existing.subagents === "string" ? [] : Object.keys(existing.subagents);
    if (keys.some((key) => key !== "*")) {
      note = "\nNote: replaced the existing per-agent entries for this profile.";
    }
    existing.main = main;
    existing.subagents = model;
  } else {
    note = shadowWarning(profiles, main);
    profiles.push({ main, subagents: model });
  }
  saveConfig(ctx, target, config, `Saved to ${target}\n  ${main} → ${model}${note}`);
}

function cmdSet(
  ctx: ExtensionContextLike,
  target: string,
  main: string,
  agent: string,
  model: string,
): void {
  const loaded = loadActiveForWrite(ctx, target);
  if (!loaded) return;
  const { config, profiles } = loaded;
  const index = findProfileIndexByMain(profiles, main);
  const existing = index >= 0 ? profiles[index] : undefined;
  const shadow = existing ? "" : shadowWarning(profiles, main);
  const profile: Profile = existing ?? { main, subagents: agent === "*" ? model : cloneSubagentMap({}) };
  if (agent === "*") {
    // Profile default: preserve existing per-agent entries; collapse to the plain
    // string form only when no per-agent entry exists (set * must not behave like add).
    if (typeof profile.subagents === "string" || Object.keys(profile.subagents).length === 0) {
      profile.subagents = model;
    } else {
      const map = cloneSubagentMap(profile.subagents);
      map["*"] = model;
      profile.subagents = map;
    }
  } else {
    // Null-prototype map (same hardening as the parse boundary): an exotic agent name like
    // "__proto__" must stay an own property instead of being coerced away on assignment.
    const map = cloneSubagentMap(
      typeof profile.subagents === "string" ? { "*": profile.subagents } : profile.subagents,
    );
    map[agent] = model;
    profile.subagents = map;
  }
  if (!existing) profiles.push(profile);
  saveConfig(
    ctx,
    target,
    config,
    `Saved to ${target}\n  ${main} → ${summarizeSubagents(profile.subagents)}${shadow}`,
  );
}

function cmdRemove(
  ctx: ExtensionContextLike,
  target: string,
  main: string,
  agent: string | undefined,
): void {
  const loaded = loadActiveForWrite(ctx, target);
  if (!loaded) return;
  const { config, profiles } = loaded;
  const index = findProfileIndexByMain(profiles, main);
  if (index < 0) {
    notify(ctx, `No profile found for main ${main} (target: ${target})`, "warning");
    return;
  }
  const profile = profiles[index];
  if (!profile) return;
  if (agent) {
    if (typeof profile.subagents === "string") {
      notify(ctx, `This profile has a single default model; use /model-sync remove ${main}`, "warning");
      return;
    }
    // Own-key check: inherited prototype members must not masquerade as removable entries.
    if (!Object.hasOwn(profile.subagents, agent)) {
      const available = Object.keys(profile.subagents).join(", ");
      notify(
        ctx,
        `Profile ${main} has no entry for agent "${agent}"${available ? `\nAvailable agents: ${available}` : ""}`,
        "warning",
      );
      return;
    }
    const map = cloneSubagentMap(profile.subagents);
    delete map[agent];
    const keys = Object.keys(map);
    if (keys.length === 0) {
      profiles.splice(index, 1);
    } else if (keys.length === 1 && keys[0] === "*") {
      // A lone default collapses back to the plain string form.
      const only = map["*"];
      if (only !== undefined) profile.subagents = only;
    } else {
      profile.subagents = map;
    }
  } else {
    profiles.splice(index, 1);
  }
  saveConfig(ctx, target, config, `Saved to ${target}`);
}

function cmdMove(
  ctx: ExtensionContextLike,
  target: string,
  main: string,
  position: string,
): void {
  if (!Object.hasOwn(POSITION_DESCRIPTIONS, position)) {
    notify(ctx, "Usage: /model-sync move <main> <top|bottom|up|down>", "warning");
    return;
  }
  const loaded = loadActiveForWrite(ctx, target);
  if (!loaded) return;
  const { config, profiles } = loaded;
  const index = findProfileIndexByMain(profiles, main);
  if (index < 0) {
    notify(ctx, `No profile found for main ${main} (target: ${target})`, "warning");
    return;
  }
  let targetIndex = index;
  if (position === "top") targetIndex = 0;
  else if (position === "bottom") targetIndex = profiles.length - 1;
  else if (position === "up") targetIndex = index - 1;
  else targetIndex = index + 1;
  if (targetIndex < 0 || targetIndex >= profiles.length) {
    const edge = position === "up" ? "top" : "bottom";
    notify(ctx, `Profile ${main} is already at the ${edge} of the active preset (target: ${target}).`, "warning");
    return;
  }
  if (targetIndex === index) {
    notify(ctx, `Profile ${main} is already in that position (target: ${target}).`);
    return;
  }
  const removed = profiles.splice(index, 1);
  profiles.splice(targetIndex, 0, ...removed);
  saveConfig(
    ctx,
    target,
    config,
    `Moved profile ${main} to position ${targetIndex + 1} of ${profiles.length} (${target}).`,
  );
}

// ── preset commands ─────────────────────────────────────────────

function formatActivePreset(config: ModelSyncConfig, effective: EffectiveConfig): string {
  if (!effective.activePreset) return "(none)";
  return isNamedConfig(config) ? effective.activePreset : `${effective.activePreset} (legacy)`;
}

function cmdPresetList(ctx: ExtensionContextLike): void {
  const view = loadActiveLayerView(ctx.cwd);
  const lines: string[] = [];
  const ok = appendLayerSummary(
    lines,
    view,
    `pi-model-sync active layer: ${view.layer.layer} (${view.layer.path})`,
  );
  if (!ok) {
    if (!view.exists) lines.push("No presets yet (/model-sync preset create <name>)");
    notify(ctx, lines.join("\n"));
    return;
  }
  const names = presetNames(view.config);
  if (names.length === 0) {
    lines.push("No presets yet (/model-sync preset create <name>)");
  } else {
    const legacySuffix = isNamedConfig(view.config) ? "" : " (legacy)";
    for (const name of names) {
      lines.push(`  ${view.effective.activePreset === name ? "*" : " "} ${name}${legacySuffix}`);
    }
  }
  notify(ctx, lines.join("\n"));
}

function cmdPresetCreate(ctx: ExtensionContextLike, target: string, name: string): void {
  if (!isValidPresetName(name)) {
    notify(ctx, `Invalid preset name "${name}". Preset names must be single tokens.`, "warning");
    return;
  }
  const config = loadForWrite(ctx, target);
  if (!config) return;
  if (!isNamedConfig(config)) {
    if (name === "default") {
      notify(ctx, `Preset "default" is the virtual legacy preset and cannot be created (target: ${target}).`, "warning");
      return;
    }
    const converted = toPresetConfig(config);
    converted.presets[name] = [];
    const note =
      config.profiles.length > 0
        ? `\nLegacy profiles moved to preset "default" (active).`
        : `\nActive preset: default.`;
    saveConfig(ctx, target, converted, `Created preset "${name}" (inactive) in ${target}${note}`);
    return;
  }
  if (Object.hasOwn(config.presets, name)) {
    notify(ctx, `Preset "${name}" already exists (target: ${target}).`, "warning");
    return;
  }
  config.presets[name] = [];
  saveConfig(ctx, target, config, `Created preset "${name}" (inactive) in ${target}`);
}

function cmdPresetCopy(
  ctx: ExtensionContextLike,
  target: string,
  source: string,
  name: string,
): void {
  if (!isValidPresetName(source) || !isValidPresetName(name)) {
    notify(ctx, "Invalid preset name. Preset names must be single tokens.", "warning");
    return;
  }
  const config = loadForWrite(ctx, target);
  if (!config) return;
  if (!isNamedConfig(config)) {
    if (name === "default") {
      notify(ctx, `Preset "default" already exists (target: ${target}).`, "warning");
      return;
    }
    if (source !== "default") {
      notify(ctx, `Preset "${source}" not found. Available presets: default (target: ${target}).`, "warning");
      return;
    }
    const converted = toPresetConfig(config);
    const defaultProfiles = converted.presets.default;
    if (!defaultProfiles) return;
    converted.presets[name] = cloneProfiles(defaultProfiles);
    const note =
      config.profiles.length > 0
        ? `\nLegacy profiles moved to preset "default" (active).`
        : `\nActive preset: default.`;
    saveConfig(
      ctx,
      target,
      converted,
      `Copied preset "default" to "${name}" (inactive) in ${target}${note}`,
    );
    return;
  }
  if (Object.hasOwn(config.presets, name)) {
    notify(ctx, `Preset "${name}" already exists (target: ${target}).`, "warning");
    return;
  }
  const sourceProfiles = getPresetProfiles(config, source);
  if (!sourceProfiles) {
    notify(
      ctx,
      `Preset "${source}" not found (target: ${target}).\n${availablePresetsHint(config)}`,
      "warning",
    );
    return;
  }
  config.presets[name] = cloneProfiles(sourceProfiles);
  saveConfig(ctx, target, config, `Copied preset "${source}" to "${name}" (inactive) in ${target}`);
}

function cmdPresetUse(ctx: ExtensionContextLike, target: string, name: string): void {
  if (!isValidPresetName(name)) {
    notify(ctx, `Invalid preset name "${name}". Preset names must be single tokens.`, "warning");
    return;
  }
  const config = loadForWrite(ctx, target);
  if (!config) return;
  if (!isNamedConfig(config)) {
    if (name === "default") {
      notify(ctx, `Preset "default" is already active (legacy config; target: ${target}).`);
      return;
    }
    notify(ctx, `Preset "${name}" not found. Available presets: default (target: ${target}).`, "warning");
    return;
  }
  if (getPresetProfiles(config, name) === undefined) {
    notify(
      ctx,
      `Preset "${name}" not found (target: ${target}).\n${availablePresetsHint(config)}`,
      "warning",
    );
    return;
  }
  if (config.activePreset === name) {
    notify(ctx, `Preset "${name}" is already active (target: ${target}).`);
    return;
  }
  config.activePreset = name;
  saveConfig(ctx, target, config, `Active preset: ${name} (${target})`);
}

function cmdPresetRemove(ctx: ExtensionContextLike, target: string, name: string): void {
  if (!isValidPresetName(name)) {
    notify(ctx, `Invalid preset name "${name}". Preset names must be single tokens.`, "warning");
    return;
  }
  const config = loadForWrite(ctx, target);
  if (!config) return;
  if (!isNamedConfig(config)) {
    if (name === "default") {
      notify(ctx, `Cannot remove the active virtual legacy preset "default" (target: ${target}).`, "warning");
      return;
    }
    notify(ctx, `Preset "${name}" not found. Available presets: default (target: ${target}).`, "warning");
    return;
  }
  if (getPresetProfiles(config, name) === undefined) {
    notify(
      ctx,
      `Preset "${name}" not found (target: ${target}).\n${availablePresetsHint(config)}`,
      "warning",
    );
    return;
  }
  if (config.activePreset === name) {
    notify(
      ctx,
      `Cannot remove the active preset "${name}" (target: ${target}).\nSwitch to another preset first: /model-sync preset use <name>.`,
      "warning",
    );
    return;
  }
  delete config.presets[name];
  saveConfig(ctx, target, config, `Removed preset "${name}" (${target})`);
}

function cmdPresetRename(
  ctx: ExtensionContextLike,
  target: string,
  oldName: string,
  newName: string,
): void {
  if (!isValidPresetName(oldName) || !isValidPresetName(newName)) {
    notify(ctx, "Invalid preset name. Preset names must be single tokens.", "warning");
    return;
  }
  const config = loadForWrite(ctx, target);
  if (!config) return;
  if (!isNamedConfig(config)) {
    if (oldName !== "default") {
      notify(ctx, `Preset "${oldName}" not found. Available presets: default (target: ${target}).`, "warning");
      return;
    }
    if (oldName === newName) {
      notify(ctx, `Preset "${oldName}" is already named that (target: ${target}).`);
      return;
    }
    const converted = toPresetConfig(config);
    const defaultProfiles = converted.presets.default;
    if (!defaultProfiles) return;
    const renamed: PresetMap = Object.create(null) as PresetMap;
    renamed[newName] = defaultProfiles;
    saveConfig(
      ctx,
      target,
      { activePreset: newName, presets: renamed },
      `Renamed preset "default" to "${newName}" (active) in ${target}.`,
    );
    return;
  }
  const profiles = getPresetProfiles(config, oldName);
  if (profiles === undefined) {
    notify(
      ctx,
      `Preset "${oldName}" not found (target: ${target}).\n${availablePresetsHint(config)}`,
      "warning",
    );
    return;
  }
  if (oldName === newName) {
    notify(ctx, `Preset "${oldName}" is already named that (target: ${target}).`);
    return;
  }
  if (getPresetProfiles(config, newName) !== undefined) {
    notify(ctx, `Preset "${newName}" already exists (target: ${target}).`, "warning");
    return;
  }
  const presets: PresetMap = Object.create(null) as PresetMap;
  for (const [name, list] of Object.entries(config.presets)) {
    presets[name === oldName ? newName : name] = list;
  }
  config.presets = presets;
  if (config.activePreset === oldName) config.activePreset = newName;
  const activeNote = config.activePreset === newName ? " (active)" : "";
  saveConfig(ctx, target, config, `Renamed preset "${oldName}" to "${newName}"${activeNote} (${target}).`);
}

// ── display commands ────────────────────────────────────────────

interface LayerView {
  layer: { path: string; layer: "project" | "global" };
  config: ModelSyncConfig;
  effective: EffectiveConfig;
  error: string | null;
  exists: boolean;
  warnings: string[];
}

function loadActiveLayerView(cwd: string): LayerView {
  const layer = resolveActiveLayer(cwd);
  const read = readLayer(layer.path);
  return {
    layer,
    config: read.config,
    effective: projectActiveProfiles(read.config),
    error: read.error,
    exists: read.exists,
    warnings: read.warnings,
  };
}

/** Shared header for list, preset list, and show. Returns false when there is no usable config. */
function appendLayerSummary(lines: string[], view: LayerView, header: string): boolean {
  lines.push(header);
  if (!view.exists) {
    lines.push("No config file yet.");
    return false;
  }
  if (view.error) {
    lines.push(view.error);
    return false;
  }
  lines.push(`Active preset: ${formatActivePreset(view.config, view.effective)}`);
  if (view.effective.warning) lines.push(view.effective.warning);
  for (const warning of view.warnings) lines.push(`Config warning: ${warning}`);
  return true;
}

function appendInactiveLayer(lines: string[], view: LayerView): void {
  if (!view.exists) return;
  lines.push(`(inactive) ${view.layer.layer} layer: ${view.layer.path}`);
  if (view.error) {
    lines.push(`  ${view.error}`);
    return;
  }
  lines.push(`  Active preset: ${formatActivePreset(view.config, view.effective)}`);
  if (view.effective.warning) lines.push(`  ${view.effective.warning}`);
  for (const warning of view.warnings) lines.push(`  Config warning: ${warning}`);
  if (view.effective.profiles.length === 0) {
    lines.push("  No profiles in the inactive layer");
  } else {
    for (const profile of view.effective.profiles) {
      lines.push(`      ${profile.main} → ${summarizeSubagents(profile.subagents)}`);
    }
  }
}

function cmdList(ctx: ExtensionContextLike): void {
  const view = loadActiveLayerView(ctx.cwd);
  const lines: string[] = [];
  const ok = appendLayerSummary(
    lines,
    view,
    `pi-model-sync active layer: ${view.layer.layer} (${view.layer.path})`,
  );
  if (!ok) {
    if (!view.exists) {
      lines.push("No profiles yet. Create the config with /model-sync add <main> <model>.");
    } else if (view.error) {
      lines.push("No profiles are active because the active config has an error.");
    }
  } else {
    const modelRef = currentModelRef(ctx);
    const hit = findProfile(view.effective, modelRef);
    if (view.effective.profiles.length === 0) {
      lines.push("No profiles in the active preset (/model-sync add <main> <model>)");
    } else {
      for (const profile of view.effective.profiles) {
        lines.push(`  ${hit === profile ? "*" : " "} ${profile.main} → ${summarizeSubagents(profile.subagents)}`);
      }
    }
  }
  const otherLayer = view.layer.layer === "project" ? "global" : "project";
  const otherPath = otherLayer === "project" ? getProjectConfigPath(ctx.cwd) : getGlobalConfigPath(ctx.cwd);
  if (otherPath !== view.layer.path) {
    const otherRead = readLayer(otherPath);
    appendInactiveLayer(lines, {
      layer: { path: otherPath, layer: otherLayer },
      config: otherRead.config,
      effective: projectActiveProfiles(otherRead.config),
      error: otherRead.error,
      exists: otherRead.exists,
      warnings: otherRead.warnings,
    });
  }
  notify(ctx, lines.join("\n"));
}

function resolveStatus(
  ctx: ExtensionContextLike,
  selector: string,
  snapshot: RegistrySnapshot,
): string {
  const usesOmpResolver = ctx.models !== undefined && typeof ctx.models.resolve === "function";
  if (!usesOmpResolver && ctx.modelRegistry && selector.includes("*")) {
    return " (glob; the child process resolves it)";
  }
  const ok = selectorResolvable(ctx, selector, snapshot);
  if (ok === true) return " (resolvable)";
  if (ok === false) return " (unresolvable)";
  return " (this host cannot pre-validate; the child process will resolve it)";
}

function parseModelArgument(value: string): CurrentModelRef | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash > 0) return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
  return { provider: "", id: trimmed };
}

function cmdShow(ctx: ExtensionContextLike, modelArg?: string, agentArg?: string): void {
  const requestedRef = modelArg === undefined ? undefined : parseModelArgument(modelArg);
  if (modelArg !== undefined && !requestedRef) {
    notify(ctx, "Usage: /model-sync show [model] [agent]", "warning");
    return;
  }
  const modelRef = requestedRef ?? currentModelRef(ctx);
  const current = modelRef
    ? modelRef.provider
      ? `${modelRef.provider}/${modelRef.id}`
      : modelRef.id
    : "(unknown)";
  const view = loadActiveLayerView(ctx.cwd);
  const lines: string[] = [];
  lines.push(`${requestedRef ? "Requested" : "Current session"} model: ${current}`);
  const ok = appendLayerSummary(lines, view, `Active layer: ${view.layer.layer} (${view.layer.path})`);
  if (!ok) {
    if (!view.exists) lines.push("Nothing to match yet. Create the config with /model-sync add <main> <model>.");
    notify(ctx, lines.join("\n"));
    return;
  }
  const profile = findProfile(view.effective, modelRef);
  if (!profile) {
    lines.push(`No matching profile for ${current}`);
    notify(ctx, lines.join("\n"));
    return;
  }
  lines.push(`Matched profile: main=${profile.main}`);
  const snapshot = createRegistrySnapshot();
  if (agentArg !== undefined) {
    const selector = pickSubagentSelector(profile, agentArg);
    if (!selector) {
      lines.push(`No selector for agent "${agentArg}" under this profile.`);
    } else {
      lines.push(`  ${agentArg} → ${selector}${resolveStatus(ctx, selector, snapshot)}`);
    }
  } else if (typeof profile.subagents === "string") {
    lines.push(`  * → ${profile.subagents}${resolveStatus(ctx, profile.subagents, snapshot)}`);
  } else {
    const statusCache = new Map<string, string>();
    for (const [agentName, selector] of Object.entries(profile.subagents)) {
      let status = statusCache.get(selector);
      if (status === undefined) {
        status = resolveStatus(ctx, selector, snapshot);
        statusCache.set(selector, status);
      }
      lines.push(`  ${agentName} → ${selector}${status}`);
    }
  }
  notify(ctx, lines.join("\n"));
}

// ── extension entry ─────────────────────────────────────────────

export default function modelSync(pi: ExtensionAPI): void {
  // Upstream pi's setLabel is (entryId, label)-shaped; skip when the omp usage is
  // incompatible there — functionality is unaffected.
  try {
    if ("setLabel" in pi && typeof pi.setLabel === "function") {
      pi.setLabel("Model Sync");
    }
  } catch {}

  // Upstream pi has no before_subagent_spawn event; a failed registration does not
  // affect the tool_call path below.
  try {
    pi.on("before_subagent_spawn", handleBeforeSubagentSpawn);
  } catch {}

  pi.on("tool_call", (event: ToolCallEventLike, ctx: ExtensionContextLike) =>
    handleToolCall(event, ctx, pi),
  );
  pi.registerCommand("model-sync", {
    description: "Manage main-model → subagent model mappings",
    getArgumentCompletions: modelSyncArgumentCompletions,
    handler: commandHandler,
  });
}
