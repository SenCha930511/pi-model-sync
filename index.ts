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
 * 17. Session presets and pauses are in memory; command writes stay on disk.
 * 18. A slash is provider/id first and a bare id second (model ids may contain `/`).
 * 19. Config writes follow symlinks and surface unknown keys before a rewrite.
 */
// Type-only and erased at runtime; the upstream package name keeps npm/pi-gallery tooling happy,
// while omp supplies the same ambient ExtensionAPI surface under either name.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commandHandler } from "./commands";
import { modelSyncArgumentCompletions } from "./completions";
import { handleBeforeSubagentSpawn, handleToolCall } from "./hooks";
import { createSessionState, refreshSessionCache } from "./session";
import type { ExtensionContextLike, SubagentSpawnEvent, ToolCallEventLike } from "./resolver";

export default function modelSync(pi: ExtensionAPI): void {
  const state = createSessionState();

  // omp's setLabel(label) tags the extension. Upstream pi's setLabel(entryId, label)
  // is an entry-bookmark API: a one-argument call would clear the label of a
  // nonexistent entry instead of throwing, so gate on the declared arity.
  try {
    if ("setLabel" in pi && typeof pi.setLabel === "function" && pi.setLabel.length === 1) {
      pi.setLabel("Model Sync");
    }
  } catch {}

  // Upstream pi has no before_subagent_spawn event; a failed registration does not
  // affect the tool_call path below.
  try {
    pi.on("before_subagent_spawn", (event: unknown, ctx: unknown) =>
      handleBeforeSubagentSpawn(event as SubagentSpawnEvent, ctx as ExtensionContextLike, state),
    );
  } catch {}

  pi.on("tool_call", (event: unknown, ctx: unknown) =>
    handleToolCall(event as ToolCallEventLike, ctx as ExtensionContextLike, state, pi),
  );

  // Cache the session cwd and authenticated model ids for completion, whose host
  // callback has no context object. session_start exists on both hosts; model_select
  // exists only upstream, so its registration is best-effort.
  try {
    pi.on("session_start", (_event: unknown, ctx: unknown) =>
      refreshSessionCache(ctx as ExtensionContextLike, state),
    );
  } catch {}
  try {
    pi.on("model_select", (event: unknown, ctx: unknown) => {
      const model =
        event && typeof event === "object" && "model" in event ? event.model : undefined;
      refreshSessionCache(ctx as ExtensionContextLike, state, model);
    });
  } catch {}

  pi.registerCommand("model-sync", {
    description: "Manage main-model → subagent model mappings",
    getArgumentCompletions: (prefix: string) => modelSyncArgumentCompletions(prefix, state),
    handler: (args: string, ctx: never) =>
      commandHandler(args, ctx as ExtensionContextLike, { state, pi }),
  });
}
