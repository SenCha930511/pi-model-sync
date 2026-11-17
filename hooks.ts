/**
 * Interception paths. The spawn path routes omp's native `before_subagent_spawn`;
 * the tool path routes supported third-party subagent plugins. Both paths must never
 * throw: any failure returns undefined and leaves the host's default routing intact.
 */

import { ADAPTER_TOOL_NAMES, applyModelSpec, normalizeSelector, selectAdapter } from "./adapters";
import { findProfile, pickSubagentSelector, readConfig } from "./config";
import type { CurrentModelRef } from "./config";
import {
  bareSelectorUnique,
  createRegistrySnapshot,
  currentModelRef,
  formatModelRef,
  parseSelector,
  readToolInfos,
  sameModelRef,
  selectorKind,
  selectorRefs,
  selectorResolvable,
} from "./resolver";
import type {
  ExtensionContextLike,
  RegistrySnapshot,
  SubagentSpawnEvent,
  ToolCallEventLike,
  ToolHost,
} from "./resolver";
import {
  recordRoute,
  sessionSelection,
  warnAdapterConflictOnce,
  warnUnresolvableOnce,
} from "./session";
import type { SessionState } from "./session";

export interface SpawnRoutingResult {
  model: string[];
  note: string;
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

/**
 * omp does not expose perCallModel on the event. When the caller supplied one, the core
 * reports no modelRole and the caller's pattern list, which differs from the spawning
 * session's model. A normal spawn without a role reports the current model instead, so
 * this guard leaves that case routable. Decision 11: an explicit model always wins.
 */
function isExplicitPerCallModel(event: SubagentSpawnEvent, modelRef: CurrentModelRef): boolean {
  if (event.invocationKind === undefined || event.modelRole !== undefined) return false;
  const rawPatterns = event.patterns;
  const patterns = Array.isArray(rawPatterns)
    ? rawPatterns
    : typeof rawPatterns === "string"
      ? [rawPatterns]
      : [];
  const refs = patterns
    .filter((pattern): pattern is string => typeof pattern === "string")
    .flatMap((pattern) => {
      const parsed = parseSelector(pattern);
      return parsed ? selectorRefs(parsed) : [];
    });
  if (refs.length === 0) return false;
  return !refs.some((ref) => sameModelRef(ref, modelRef));
}

export function handleBeforeSubagentSpawn(
  event: SubagentSpawnEvent,
  ctx: ExtensionContextLike,
  state: SessionState,
): SpawnRoutingResult | undefined {
  try {
    // Cheap guards first (hot path): an unrecognizable session model can never match
    // a profile, so the config read is skipped entirely.
    const modelRef = currentModelRef(ctx);
    if (!modelRef) return undefined;
    const agentName = extractAgentName(event);
    if (state.paused) {
      recordRoute(state, {
        at: Date.now(),
        path: "spawn",
        agent: agentName,
        main: formatModelRef(modelRef),
        outcome: "skipped: session paused",
      });
      return undefined;
    }
    if (isExplicitPerCallModel(event, modelRef)) {
      recordRoute(state, {
        at: Date.now(),
        path: "spawn",
        agent: agentName,
        main: formatModelRef(modelRef),
        outcome: "skipped: explicit per-call model",
      });
      return undefined;
    }
    const profile = findProfile(readConfig(ctx.cwd, sessionSelection(state)), modelRef);
    if (!profile) {
      recordRoute(state, {
        at: Date.now(),
        path: "spawn",
        agent: agentName,
        main: formatModelRef(modelRef),
        outcome: "skipped: no matching profile",
      });
      return undefined;
    }
    const selector = pickSubagentSelector(profile, agentName);
    if (!selector) return undefined;
    const ok = selectorResolvable(ctx, selector);
    if (ok === false) {
      warnUnresolvableOnce(ctx, state, selector, "using default routing for this spawn");
      recordRoute(state, {
        at: Date.now(),
        path: "spawn",
        agent: agentName,
        main: profile.main,
        selector,
        outcome: "skipped: selector unresolvable",
      });
      return undefined;
    }
    const rawPatterns = event.patterns;
    const basePatterns = Array.isArray(rawPatterns)
      ? rawPatterns.filter((pattern): pattern is string => typeof pattern === "string")
      : typeof rawPatterns === "string"
        ? [rawPatterns]
        : [];
    const patterns = basePatterns.filter((pattern) => pattern !== selector);
    recordRoute(state, {
      at: Date.now(),
      path: "spawn",
      agent: agentName,
      main: profile.main,
      selector,
      model: selector,
      outcome: "routed",
    });
    return {
      model: [selector, ...patterns],
      note: `pi-model-sync: ${agentName} → ${selector} (main: ${profile.main})`,
    };
  } catch {
    return undefined; // decision 10: the spawn-interception path must never throw
  }
}

export function handleToolCall(
  event: ToolCallEventLike,
  ctx: ExtensionContextLike,
  state: SessionState,
  pi?: ToolHost,
): void {
  try {
    if (typeof event.toolName !== "string" || !ADAPTER_TOOL_NAMES.has(event.toolName)) {
      return;
    }
    const input = event.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const inputRecord = input as Record<string, unknown>;
    // Decision 15: schema first, call shape second. An explicit model, a resume, or a
    // management call collects no slot, so the config read never happens for it.
    const selection = selectAdapter(event.toolName, inputRecord, readToolInfos(pi));
    if (selection.kind === "ambiguous") {
      warnAdapterConflictOnce(ctx, state, event.toolName, selection.adapters);
      return;
    }
    if (selection.kind === "none") return;
    const modelRef = currentModelRef(ctx);
    if (!modelRef) return;
    if (state.paused) {
      recordRoute(state, {
        at: Date.now(),
        path: "tool",
        agent: "*",
        main: formatModelRef(modelRef),
        adapter: selection.adapter.id,
        outcome: "skipped: session paused",
      });
      return;
    }
    const profile = findProfile(readConfig(ctx.cwd, sessionSelection(state)), modelRef);
    if (!profile) return;
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
          state,
          selector,
          `cannot route ${selection.adapter.label}; using its default model`,
        );
        recordRoute(state, {
          at: Date.now(),
          path: "tool",
          agent: slot.agentName,
          main: profile.main,
          selector,
          adapter: selection.adapter.id,
          outcome: "skipped: selector not expressible in plugin dialect",
        });
        continue;
      }
      if (!selection.adapter.dialect.allowBareId) {
        registrySnapshot ??= createRegistrySnapshot();
        if (selectorKind(ctx, spec.base, registrySnapshot) === "bare") {
          warnUnresolvableOnce(
            ctx,
            state,
            selector,
            `cannot route ${selection.adapter.label}; using its default model`,
          );
          recordRoute(state, {
            at: Date.now(),
            path: "tool",
            agent: slot.agentName,
            main: profile.main,
            selector,
            adapter: selection.adapter.id,
            outcome: "skipped: bare id rejected by plugin dialect",
          });
          continue;
        }
      }
      if (selection.adapter.dialect.uniqueBareId) {
        registrySnapshot ??= createRegistrySnapshot();
        if (bareSelectorUnique(ctx, spec.base, registrySnapshot, modelRef) === false) {
          warnUnresolvableOnce(
            ctx,
            state,
            selector,
            "the bare model id matches more than one provider; use provider/id",
          );
          recordRoute(state, {
            at: Date.now(),
            path: "tool",
            agent: slot.agentName,
            main: profile.main,
            selector,
            adapter: selection.adapter.id,
            outcome: "skipped: bare id matches multiple providers",
          });
          continue;
        }
      }
      if (!resolutionCache.has(spec.base)) {
        registrySnapshot ??= createRegistrySnapshot();
        resolutionCache.set(spec.base, selectorResolvable(ctx, spec.base, registrySnapshot));
      }
      if (resolutionCache.get(spec.base) === false) {
        warnUnresolvableOnce(ctx, state, selector, "using the default model for this subagent delegation");
        recordRoute(state, {
          at: Date.now(),
          path: "tool",
          agent: slot.agentName,
          main: profile.main,
          selector,
          adapter: selection.adapter.id,
          outcome: "skipped: selector unresolvable",
        });
        continue;
      }
      applyModelSpec(slot, spec, selection.adapter.dialect);
      recordRoute(state, {
        at: Date.now(),
        path: "tool",
        agent: slot.agentName,
        main: profile.main,
        selector,
        model: spec.base,
        adapter: selection.adapter.id,
        outcome: "routed",
      });
    }
    // The host applies in-place mutations: upstream documents mutating event.input, and
    // omp passes the same object for non-edit tools. Returning { input } would overwrite
    // another extension's last-wins input on omp and rely on an unknown upstream field.
  } catch {
    // never throws, the same never-throw invariant as the native path
  }
}
