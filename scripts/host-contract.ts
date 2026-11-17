/**
 * Compile-time contract probe against the installed host packages. The shipped code
 * only sees `scripts/host-stub.d.ts`; this file catches an upstream rename or removal
 * of the fields pi-model-sync actually reads. Run by `npm run typecheck`.
 */

import type {
  ExtensionAPI as UpstreamAPI,
  ExtensionContext as UpstreamContext,
  ModelRegistry as UpstreamModelRegistry,
  ModelSelectEvent as UpstreamModelSelect,
  SessionStartEvent as UpstreamSessionStart,
  ToolCallEvent as UpstreamToolCall,
  ToolCallEventResult as UpstreamToolCallResult,
} from "@earendil-works/pi-coding-agent";
import type {
  BeforeSubagentSpawnEvent,
  BeforeSubagentSpawnEventResult,
  ExtensionAPI as OmpAPI,
  ExtensionContext as OmpContext,
  ExtensionModelQuery,
  ExtensionUIContext,
  ToolCallEventResult as OmpToolCallResult,
} from "@oh-my-pi/pi-coding-agent";

type Assert<T extends true> = T;
type Has<T, K extends PropertyKey> = K extends keyof T ? true : false;
type Not<T extends boolean> = T extends true ? false : true;

export type UpstreamResultHasNoInput = Assert<Not<Has<UpstreamToolCallResult, "input">>>;
export type UpstreamEventHasInput = Assert<Has<UpstreamToolCall, "input">>;
export type UpstreamContextHasRegistry = Assert<Has<UpstreamContext, "modelRegistry">>;
export type UpstreamContextHasUi = Assert<Has<UpstreamContext, "ui">>;
export type UpstreamRegistryHasFind = Assert<Has<UpstreamModelRegistry, "find">>;
export type UpstreamRegistryHasAvailable = Assert<Has<UpstreamModelRegistry, "getAvailable">>;
export type UpstreamContextHasModel = Assert<Has<UpstreamContext, "model">>;
export type UpstreamApiHasGetAllTools = Assert<Has<UpstreamAPI, "getAllTools">>;
export type UpstreamApiHasRegisterCommand = Assert<Has<UpstreamAPI, "registerCommand">>;
export type UpstreamApiHasSetLabel = Assert<Has<UpstreamAPI, "setLabel">>;

export type OmpSpawnHasModelRole = Assert<Has<BeforeSubagentSpawnEvent, "modelRole">>;
export type OmpSpawnHasInvocationKind = Assert<Has<BeforeSubagentSpawnEvent, "invocationKind">>;
export type OmpSpawnResultHasModel = Assert<Has<BeforeSubagentSpawnEventResult, "model">>;
export type OmpToolResultHasInput = Assert<Has<OmpToolCallResult, "input">>;
export type OmpContextHasModels = Assert<Has<OmpContext, "models">>;
export type OmpContextHasHasUI = Assert<Has<OmpContext, "hasUI">>;
export type OmpUiHasSetStatus = Assert<Has<ExtensionUIContext, "setStatus">>;
export type OmpUiHasSelect = Assert<Has<ExtensionUIContext, "select">>;
export type OmpModelsHasList = Assert<Has<ExtensionModelQuery, "list">>;
export type OmpModelsHasCurrent = Assert<Has<ExtensionModelQuery, "current">>;
export type OmpModelsHasResolve = Assert<Has<ExtensionModelQuery, "resolve">>;
export type OmpApiHasGetAllTools = Assert<Has<OmpAPI, "getAllTools">>;
export type OmpApiHasRegisterCommand = Assert<Has<OmpAPI, "registerCommand">>;
export type OmpApiHasSetLabel = Assert<Has<OmpAPI, "setLabel">>;

export function probeUpstream(api: UpstreamAPI, ctx: UpstreamContext): void {
  api.on("session_start", (event: UpstreamSessionStart) => {
    const reason: UpstreamSessionStart["reason"] = event.reason;
    void reason;
  });
  api.on("model_select", (event: UpstreamModelSelect) => {
    const source: UpstreamModelSelect["source"] = event.source;
    void source;
  });
  api.on("tool_call", (event: UpstreamToolCall) => {
    if ("input" in event && event.input && typeof event.input === "object") {
      const input = event.input as Record<string, unknown>;
      input.model = "probe";
    }
    return undefined;
  });
  const registry: UpstreamModelRegistry = ctx.modelRegistry;
  const auth = registry.hasConfiguredAuth;
  const find = registry.find;
  void auth;
  void find;
  ctx.ui.setStatus("pi-model-sync", "ok");
  ctx.ui.select("Select", ["a"]);
  const current: UpstreamContext["model"] = ctx.model;
  void current;
  api.getAllTools();
  api.registerCommand("probe", {
    description: "probe",
    getArgumentCompletions: (prefix: string) => (prefix ? null : []),
    handler: async () => {},
  });
  // Upstream's two-parameter form; omp's one-parameter call is probed below.
  api.setLabel("probe-entry", undefined);
}

export function probeOmp(api: OmpAPI, ctx: OmpContext): void {
  const event: BeforeSubagentSpawnEvent = {
    type: "before_subagent_spawn",
    agent: "task",
    invocationKind: "task",
    patterns: [],
  };
  const role: string | undefined = event.modelRole;
  void role;
  const result: BeforeSubagentSpawnEventResult = { model: ["a"], note: "b" };
  void result;
  api.on("before_subagent_spawn", () => ({ model: ["a"] }));
  api.on("session_start", () => {});
  api.on("tool_call", () => ({ input: { model: "probe" } }));
  const models: ExtensionModelQuery = ctx.models;
  const listed: unknown[] = models.list();
  void listed;
  ctx.ui.setStatus("pi-model-sync", "ok");
  const hasUI: boolean = ctx.hasUI;
  void hasUI;
  const currentModel = models.current();
  void currentModel;
  const resolved = models.resolve("openai/gpt-6");
  void resolved;
  api.getAllTools();
  api.registerCommand("probe", {
    description: "probe",
    getArgumentCompletions: (prefix: string) => (prefix ? null : []),
    handler: async () => {},
  });
  api.setLabel("probe");
}
