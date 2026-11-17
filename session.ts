/**
 * Per-session state. The host calls the extension factory once per session, so these
 * sets and buffers live in the factory closure instead of module scope. Two sessions
 * in one process do not share warning dedupe or temporary routing choices.
 */

import { availableModelIds, formatModelRef, toModelRef } from "./resolver";
import type { ExtensionContextLike, NotifyLevel } from "./resolver";
import type { SubagentAdapter } from "./adapters";
import type { SessionSelection } from "./config";

export const ROUTE_LOG_LIMIT = 50;

export interface RouteLogEntry {
  at: number;
  path: "spawn" | "tool";
  agent: string;
  main?: string;
  selector?: string;
  model?: string;
  adapter?: string;
  outcome: string;
}

export interface SessionState {
  warnedSelectors: Set<string>;
  warnedAdapterConflicts: Set<string>;
  routeLog: RouteLogEntry[];
  /** In-memory preset override; never written to disk. */
  presetOverride?: string;
  paused: boolean;
  cwd?: string;
  availableModels: string[];
  statusVisible: boolean;
}

export function createSessionState(): SessionState {
  return {
    warnedSelectors: new Set(),
    warnedAdapterConflicts: new Set(),
    routeLog: [],
    paused: false,
    availableModels: [],
    statusVisible: false,
  };
}

export function sessionSelection(state: SessionState): SessionSelection {
  if (state.paused) return { paused: true };
  return state.presetOverride === undefined ? {} : { preset: state.presetOverride };
}

export function recordRoute(state: SessionState, entry: RouteLogEntry): void {
  state.routeLog.push(entry);
  if (state.routeLog.length > ROUTE_LOG_LIMIT) state.routeLog.shift();
}

export function notify(
  ctx: ExtensionContextLike,
  message: string,
  level: NotifyLevel = "info",
): void {
  if (ctx.ui && typeof ctx.ui.notify === "function") {
    ctx.ui.notify(message, level);
  }
}

/** Decision 4 helper: one-time TUI warning for a selector that failed to resolve.
 * The set is bounded so long sessions stay lean. */
export function warnUnresolvableOnce(
  ctx: ExtensionContextLike,
  state: SessionState,
  selector: string,
  tail: string,
): void {
  if (ctx.mode !== "tui" || state.warnedSelectors.has(selector)) return;
  if (state.warnedSelectors.size >= 256) state.warnedSelectors.clear();
  state.warnedSelectors.add(selector);
  notify(
    ctx,
    `pi-model-sync: selector "${selector}" could not be resolved to an available model; ${tail}`,
    "warning",
  );
}

/** Adapter conflicts are a setup problem, not a per-call one: warn once per tool + set.
 * The set is bounded so long sessions stay lean. */
export function warnAdapterConflictOnce(
  ctx: ExtensionContextLike,
  state: SessionState,
  toolName: string,
  adapters: readonly SubagentAdapter[],
): void {
  if (ctx.mode !== "tui") return;
  const ids = adapters.map((adapter) => adapter.id);
  const key = `${toolName}:${[...ids].sort().join(",")}`;
  if (state.warnedAdapterConflicts.has(key)) return;
  if (state.warnedAdapterConflicts.size >= 64) state.warnedAdapterConflicts.clear();
  state.warnedAdapterConflicts.add(key);
  notify(
    ctx,
    `pi-model-sync: tool "${toolName}" matches multiple subagent adapters (${ids.join(
      ", ",
    )}); skipping model injection`,
    "warning",
  );
}

/** Cache the session cwd and authenticated model ids for completion (which has no ctx). */
export function refreshSessionCache(
  ctx: ExtensionContextLike,
  state: SessionState,
  selected?: unknown,
): void {
  state.cwd = ctx.cwd;
  const ids = availableModelIds(ctx);
  const selectedRef = toModelRef(selected);
  if (selectedRef) {
    const full = formatModelRef(selectedRef);
    if (!ids.includes(full)) ids.unshift(full);
    if (!ids.includes(selectedRef.id)) ids.push(selectedRef.id);
  }
  state.availableModels = ids;
}

export function statusText(state: SessionState, activePreset: string | undefined): string {
  if (state.paused) return "paused";
  if (state.presetOverride !== undefined) return `session: ${state.presetOverride}`;
  return activePreset ? `active: ${activePreset}` : "active: none";
}

export function applyStatus(
  ctx: ExtensionContextLike,
  state: SessionState,
  text: string | undefined,
): void {
  if (!ctx.ui || typeof ctx.ui.setStatus !== "function") return;
  ctx.ui.setStatus("pi-model-sync", text);
  state.statusVisible = text !== undefined;
}
