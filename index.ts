/**
 * pi-model-sync — routes subagent models from the spawning session's current model.
 * Dual host: omp / upstream pi (decision 12).
 *
 * Two interception paths:
 * 1. omp native before_subagent_spawn: fires in the spawning session (nested spawns
 *    included), where ctx.models.current() is that session's model; on a resolvable
 *    profile hit, the child's model is rewritten (original patterns stay as the retry
 *    fallback chain). Upstream pi lacks this event; a failed registration is skipped.
 * 2. tool_call: intercepts @mjakl/pi-subagent's `subagent` tool — when a call carries
 *    no model, a per-call model is injected from the same profile table; an explicit
 *    per-call model always wins and is never overwritten (decision 11).
 * Everything else passes through untouched. Startup is fully silent (decision 6):
 * no session_start notification.
 */
// Type-only and erased at runtime; the upstream package name keeps npm/pi-gallery tooling happy,
// while omp supplies the same ambient ExtensionAPI surface under either name.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  configFileExists,
  findProfile,
  getGlobalConfigPath,
  getProjectConfigPath,
  pickSubagentSelector,
  readConfig,
  readLayer,
  resolveActiveLayer,
  writeConfig,
} from "./config";
import type { CurrentModelRef, ModelSyncConfig, Profile, SubagentMap } from "./config";

/** Selectors already warned about as unresolvable (once per selector). */
const warnedSelectors = new Set<string>();

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

interface UiFacade {
  notify(message: string, level?: string): void;
}

interface ExtensionContextLike {
  cwd: string;
  mode?: string;
  /** Provided by omp; upstream pi lacks it — fall back to model / modelRegistry there. */
  models?: ModelsFacade;
  /** Upstream pi's ctx.model: the current model (Model<any>-shaped, narrowed by toModelRef). */
  model?: unknown;
  /** Upstream pi's ctx.modelRegistry. */
  modelRegistry?: ModelRegistryFacade;
  ui: UiFacade;
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

/** Upstream pi's ThinkingLevel set (used to strip a selector `:level` suffix before validation). */
const PI_THINKING_LEVELS: Record<string, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

/** ctx.models.current() → { provider, id } for matching; undefined when unrecognizable. */
function toModelRef(model: unknown): CurrentModelRef | undefined {
  if (!model || typeof model !== "object") return undefined;
  let id: string | undefined;
  if ("id" in model && typeof model.id === "string") id = model.id;
  else if ("modelId" in model && typeof model.modelId === "string") id = model.modelId;
  else if ("model" in model && typeof model.model === "string") id = model.model;
  if (!id) return undefined;
  let provider = "";
  if ("provider" in model && typeof model.provider === "string") provider = model.provider;
  else if ("providerId" in model && typeof model.providerId === "string") provider = model.providerId;
  return { provider, id };
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

/** Narrow modelRegistry.getAvailable()/getAll() entries to { provider, id } (same guard as toModelRef). */
function listRegistryModels(registry: ModelRegistryFacade): CurrentModelRef[] {
  let raw: unknown;
  if (typeof registry.getAvailable === "function") raw = registry.getAvailable();
  if (!Array.isArray(raw) && typeof registry.getAll === "function") raw = registry.getAll();
  if (!Array.isArray(raw)) return [];
  const out: CurrentModelRef[] = [];
  for (const entry of raw) {
    const ref = toModelRef(entry);
    if (ref) out.push(ref);
  }
  return out;
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
 */
function piSelectorResolvable(selector: string, registry: ModelRegistryFacade): boolean {
  if (selector.startsWith("@")) return false;
  let base = selector;
  const colon = base.lastIndexOf(":");
  if (colon > 0 && PI_THINKING_LEVELS[base.slice(colon + 1)]) {
    base = base.slice(0, colon);
  }
  if (!base) return false;
  if (base.includes("*")) return true;
  const slash = base.indexOf("/");
  if (slash > 0) {
    const provider = base.slice(0, slash);
    const id = base.slice(slash + 1);
    if (typeof registry.find === "function") {
      return Boolean(registry.find(provider, id));
    }
    return listRegistryModels(registry).some((m) => m.provider === provider && m.id === id);
  }
  return listRegistryModels(registry).some((m) => m.id === base);
}

/**
 * Decision 12/13: whether the selector resolves — omp via ctx.models.resolve(); upstream
 * via modelRegistry; neither present → undefined (this host cannot pre-validate; pass
 * through for the child process to resolve).
 */
function selectorResolvable(ctx: ExtensionContextLike, selector: string): boolean | undefined {
  if (ctx.models && typeof ctx.models.resolve === "function") {
    try {
      return Boolean(ctx.models.resolve(selector));
    } catch {
      return false;
    }
  }
  if (ctx.modelRegistry) {
    return piSelectorResolvable(selector, ctx.modelRegistry);
  }
  return undefined;
}

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

function notify(ctx: ExtensionContextLike, message: string): void {
  ctx.ui.notify(message, "info");
}

export default function modelSync(pi: ExtensionAPI): void {
  // Upstream pi's setLabel is (entryId, label)-shaped; skip when the omp usage is
  // incompatible there — functionality is unaffected.
  const setLabel = (pi as { setLabel?: (label: string) => void }).setLabel;
  try {
    setLabel?.("Model Sync");
  } catch {
    // Ignore: upstream pi's setLabel semantics differ.
  }

  // ── spawn routing (decisions 1, 2, 4, 7, 10) ─────────────────────
  // Upstream pi has no before_subagent_spawn event; a failed registration does not
  // affect the tool_call path below.
  try {
    pi.on("before_subagent_spawn", (event: SubagentSpawnEvent, ctx: ExtensionContextLike) => {
      try {
        const profile = findProfile(readConfig(ctx.cwd), currentModelRef(ctx));
        if (!profile) return undefined;
        const agentName = extractAgentName(event);
        const selector = pickSubagentSelector(profile, agentName);
        if (!selector) return undefined;
        const ok = selectorResolvable(ctx, selector);
        if (ok === false) {
          // Decision 4: unresolvable selectors fall back to default routing, warned once in the TUI.
          if (ctx.mode === "tui" && !warnedSelectors.has(selector)) {
            warnedSelectors.add(selector);
            notify(ctx, `pi-model-sync: selector "${selector}" could not be resolved to an available model; using default routing for this spawn`);
          }
          return undefined;
        }
        const rawPatterns = event.patterns;
        const basePatterns = Array.isArray(rawPatterns)
          ? rawPatterns.filter((p): p is string => typeof p === "string")
          : typeof rawPatterns === "string"
            ? [rawPatterns]
            : [];
        const patterns = basePatterns.filter((p) => p !== selector);
        return {
          model: [selector, ...patterns],
          note: `pi-model-sync: ${agentName} → ${selector} (main: ${profile.main})`,
        };
      } catch {
        return undefined; // the spawn-interception path must never throw
      }
    });
  } catch {
    // Upstream pi lacks this event; skip registration.
  }

  // ── pi-subagent routing (decision 11) ────────────────────────────
  // @mjakl/pi-subagent's `subagent` tool spawns a child process per delegation under
  // either host; here a per-call model is injected before the call runs. Dual write
  // mechanisms: in-place mutation (upstream pi's revision channel) AND returning
  // { input } (omp's revision channel — last-wins, and the revised input is revalidated
  // against the tool schema; `model` is a legal optional field of pi-subagent, so it
  // passes; upstream runtime ignores unknown result fields).
  // Shape guard: only toolName === "subagent" with an input.calls array is matched, so
  // same-named tools of a different shape are untouched; every other field (agent,
  // prompt, ...) is preserved — only `model` is added. Named-session continuation calls
  // are injected too, consistent with pi-subagent's doc: a parent model change affects
  // their next call.
  pi.on("tool_call", (event: ToolCallEventLike, ctx: ExtensionContextLike) => {
    try {
      if (event.toolName !== "subagent") return undefined;
      const input = event.input;
      if (!input || typeof input !== "object") return undefined;
      // Guarded as an object above; every dynamic field (calls/agent/model...) is validated again field by field.
      const inputRecord = input as Record<string, unknown>;
      const calls = inputRecord.calls;
      if (!Array.isArray(calls) || calls.length === 0) return undefined;
      const profile = findProfile(readConfig(ctx.cwd), currentModelRef(ctx));
      if (!profile) return undefined;
      let changed = false;
      for (const call of calls) {
        if (!call || typeof call !== "object") continue;
        // Guarded as an object above; model/agent are typeof-validated before use.
        const record = call as Record<string, unknown>;
        // Decision 11: an explicit per-call model always wins and is never overwritten.
        if (typeof record.model === "string" && record.model.trim()) continue;
        const agentName = typeof record.agent === "string" ? record.agent.trim() : "";
        if (!agentName) continue;
        // exact key → "*" fallback; key matching is case-sensitive (existing semantics:
        // agent names and profile keys are aligned by the user).
        const selector = pickSubagentSelector(profile, agentName);
        if (!selector) continue;
        const ok = selectorResolvable(ctx, selector);
        if (ok === false) {
          // Same as decision 4: unresolvable → no injection; pi-subagent's default
          // (frontmatter → parent model) applies; warned once in the TUI.
          if (ctx.mode === "tui" && !warnedSelectors.has(selector)) {
            warnedSelectors.add(selector);
            notify(ctx, `pi-model-sync: selector "${selector}" could not be resolved to an available model; using the default model for this subagent delegation`);
          }
          continue;
        }
        record.model = selector;
        changed = true;
      }
      return changed ? { input } : undefined;
    } catch {
      return undefined; // never throws — the same never-throw invariant as the native path
    }
  });

  // ── /model-sync command (decisions 5, 9) ─────────────────────────
  const USAGE = [
    "pi-model-sync commands:",
    "  /model-sync [list]                      Show the active layer and all profiles",
    "  /model-sync show                        Show the current model, matched profile, and selector resolution status",
    "  /model-sync add <main> <model>          Add/update a profile (all subagents use <model>)",
    "  /model-sync set <main> <agent> <model>  Set a model for one agent (use * for the profile default)",
    "  /model-sync remove <main> [agent]       Remove a whole profile or one agent entry",
    "Writes use the global file by default. Add --project to target <cwd>/.omp/pi-model-sync.json (or <cwd>/.pi/pi-model-sync.json when the .omp file is absent and the .pi file exists).",
  ].join("\n");

  pi.registerCommand("model-sync", {
    description: "Manage main-model → subagent model mappings",
    handler: async (argsString: string, ctx: ExtensionContextLike) => {
      try {
        await handleCommand(String(argsString ?? ""), ctx);
      } catch (err) {
        notify(ctx, `pi-model-sync: command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  async function handleCommand(argsString: string, ctx: ExtensionContextLike): Promise<void> {
    const tokens = argsString.trim().split(/\s+/).filter((t) => t.length > 0);
    const useProject = tokens.includes("--project");
    const args = tokens.filter((t) => t !== "--project");
    const [sub, ...rest] = args;
    const target = useProject ? getProjectConfigPath(ctx.cwd) : getGlobalConfigPath();

    switch (sub) {
      case undefined:
      case "":
      case "list":
        cmdList(ctx);
        return;
      case "show":
        cmdShow(ctx);
        return;
      case "add": {
        const [main, model] = rest;
        if (!main || !model) {
          notify(ctx, "Usage: /model-sync add <main> <model>");
          return;
        }
        cmdAdd(ctx, target, main, model);
        return;
      }
      case "set": {
        const [main, agent, model] = rest;
        if (!main || !agent || !model) {
          notify(ctx, "Usage: /model-sync set <main> <agent> <model>");
          return;
        }
        cmdSet(ctx, target, main, agent, model);
        return;
      }
      case "remove": {
        const [main, agent] = rest;
        if (!main) {
          notify(ctx, "Usage: /model-sync remove <main> [agent]");
          return;
        }
        cmdRemove(ctx, target, main, agent);
        return;
      }
      default:
        notify(ctx, USAGE);
    }
  }

  /** Read target for writing; refuse to write when the file exists but is corrupt (avoids clobbering half-edited user content). */
  function loadForWrite(ctx: ExtensionContextLike, target: string): ModelSyncConfig | null {
    const layer = readLayer(target);
    if (layer.error && configFileExists(target)) {
      notify(ctx, `pi-model-sync: ${layer.error}\nRepair or delete this file before running a write command.`);
      return null;
    }
    return {
      profiles: layer.config.profiles.map((p) => ({
        main: p.main,
        subagents: typeof p.subagents === "string" ? p.subagents : { ...p.subagents },
      })),
    };
  }

  function cmdAdd(ctx: ExtensionContextLike, target: string, main: string, model: string): void {
    const config = loadForWrite(ctx, target);
    if (!config) return;
    const existing = config.profiles.find((p) => p.main.toLowerCase() === main.toLowerCase());
    if (existing) {
      existing.main = main;
      existing.subagents = model;
    } else {
      config.profiles.push({ main, subagents: model });
    }
    writeConfig(target, config);
    notify(ctx, `Saved to ${target}\n  ${main} → ${model}`);
  }

  function cmdSet(
    ctx: ExtensionContextLike,
    target: string,
    main: string,
    agent: string,
    model: string,
  ): void {
    const config = loadForWrite(ctx, target);
    if (!config) return;
    const existing = config.profiles.find((p) => p.main.toLowerCase() === main.toLowerCase());
    const profile: Profile = existing ?? { main, subagents: {} };
    if (agent === "*") {
      profile.subagents = model;
    } else {
      // Null-prototype map (same hardening as normalizeConfig): an exotic agent name like
      // "__proto__" must stay an own property instead of being coerced away on assignment.
      const map: SubagentMap = Object.create(null) as SubagentMap;
      Object.assign(map, typeof profile.subagents === "string" ? { "*": profile.subagents } : profile.subagents);
      map[agent] = model;
      profile.subagents = map;
    }
    if (!existing) config.profiles.push(profile);
    writeConfig(target, config);
    notify(ctx, `Saved to ${target}\n  ${main} → ${summarizeSubagents(profile.subagents)}`);
  }

  function cmdRemove(
    ctx: ExtensionContextLike,
    target: string,
    main: string,
    agent: string | undefined,
  ): void {
    const config = loadForWrite(ctx, target);
    if (!config) return;
    const idx = config.profiles.findIndex((p) => p.main.toLowerCase() === main.toLowerCase());
    if (idx < 0) {
      notify(ctx, `No profile found for main ${main} (target: ${target})`);
      return;
    }
    const profile = config.profiles[idx];
    if (agent) {
      if (typeof profile.subagents === "string") {
        notify(ctx, `This profile has a single default model; use /model-sync remove ${main}`);
        return;
      }
      // Own-key check: inherited prototype members must not masquerade as removable entries.
      if (!Object.hasOwn(profile.subagents, agent)) {
        notify(ctx, `Profile ${main} has no entry for agent "${agent}"`);
        return;
      }
      const map: SubagentMap = { ...profile.subagents };
      delete map[agent];
      if (Object.keys(map).length === 0) {
        config.profiles.splice(idx, 1);
      } else {
        profile.subagents = map;
      }
    } else {
      config.profiles.splice(idx, 1);
    }
    writeConfig(target, config);
    notify(ctx, `Saved to ${target}`);
  }

  function cmdList(ctx: ExtensionContextLike): void {
    const layer = resolveActiveLayer(ctx.cwd);
    const active = readLayer(layer.path);
    const lines: string[] = [];
    lines.push(
      `pi-model-sync active layer: ${layer.layer} — ${layer.path}`,
    );
    if (active.error) lines.push(active.error);
    const modelRef = currentModelRef(ctx);
    const hit = findProfile(active.config, modelRef);
    if (active.config.profiles.length === 0) {
      lines.push("No profiles yet (/model-sync add <main> <model>)");
    } else {
      for (const profile of active.config.profiles) {
        lines.push(`  ${hit === profile ? "*" : " "} ${profile.main} → ${summarizeSubagents(profile.subagents)}`);
      }
    }
    const otherPath =
      layer.layer === "project" ? getGlobalConfigPath() : getProjectConfigPath(ctx.cwd);
    if (otherPath !== layer.path && configFileExists(otherPath)) {
      const other = readLayer(otherPath);
      lines.push(`(inactive) ${layer.layer === "project" ? "global" : "project"} layer: ${otherPath}`);
      if (other.error) lines.push(`  ${other.error}`);
      for (const profile of other.config.profiles) {
        lines.push(`      ${profile.main} → ${summarizeSubagents(profile.subagents)}`);
      }
    }
    notify(ctx, lines.join("\n"));
  }

  function resolveStatus(ctx: ExtensionContextLike, selector: string): string {
    // Decision 12/13, three states: validate via omp/models, via pi/modelRegistry tiers, or defer to the child process when neither exists.
    const ok = selectorResolvable(ctx, selector);
    if (ok === true) return " (resolvable)";
    if (ok === false) return " (unresolvable)";
    return " (this host cannot pre-validate; the child process will resolve it)";
  }

  function cmdShow(ctx: ExtensionContextLike): void {
    const modelRef = currentModelRef(ctx);
    const current = modelRef
      ? modelRef.provider
        ? `${modelRef.provider}/${modelRef.id}`
        : modelRef.id
      : "(unknown)";
    const layer = resolveActiveLayer(ctx.cwd);
    const active = readLayer(layer.path);
    const lines: string[] = [];
    lines.push(`Current session model: ${current}`);
    lines.push(
      `Active layer: ${layer.layer} — ${layer.path}`,
    );
    if (active.error) lines.push(active.error);
    const profile = findProfile(active.config, modelRef);
    if (!profile) {
      lines.push(`No matching profile for the current model ${current}`);
    } else {
      lines.push(`Matched profile: main=${profile.main}`);
      if (typeof profile.subagents === "string") {
        lines.push(`  * → ${profile.subagents}${resolveStatus(ctx, profile.subagents)}`);
      } else {
        for (const [agentName, selector] of Object.entries(profile.subagents)) {
          lines.push(`  ${agentName} → ${selector}${resolveStatus(ctx, selector)}`);
        }
      }
    }
    notify(ctx, lines.join("\n"));
  }
}
