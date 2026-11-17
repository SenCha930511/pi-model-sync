import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import modelSync from "../index";

export interface NotifyRecord {
  message: string;
  level: "info" | "warning" | "error";
}

export interface MockCommand {
  description: string;
  getArgumentCompletions?: (
    prefix: string,
  ) => Array<{ value: string; label: string; description?: string }> | null;
  handler: (args: string, ctx: unknown) => Promise<void> | void;
}

const tempRoots: string[] = [];
const savedEnv = {
  PI_MODEL_SYNC_CONFIG: process.env.PI_MODEL_SYNC_CONFIG,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

export function makeTempDir(prefix = "pi-model-sync-test-"): string {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), prefix));
  tempRoots.push(dir);
  return dir;
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function useIsolatedConfig(): void {
  beforeEach(() => {
    const isolatedAgent = makeTempDir("isolated-agent-");
    delete process.env.PI_MODEL_SYNC_CONFIG;
    process.env.PI_CODING_AGENT_DIR = path.join(isolatedAgent, "agent");
  });

  afterEach(() => {
    restoreEnv();
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
}

export interface HostHarnessOptions {
  /** Simulate upstream pi's two-parameter setLabel(entryId, label) shape. */
  upstreamLabel?: boolean;
  failLabel?: boolean;
  failSpawnHook?: boolean;
  failSessionHook?: boolean;
  failModelHook?: boolean;
  tools?: unknown[];
  failTools?: boolean;
  hasUI?: boolean;
  select?: (title: string, options: readonly string[]) => Promise<string | undefined>;
  setStatus?: (key: string, text: string | undefined) => void;
}

export function createHostHarness(options: HostHarnessOptions = {}) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  let command: MockCommand | undefined;
  let label: string | undefined;
  const labelCalls: string[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];

  const api = {
    ...(options.upstreamLabel
      ? {
          setLabel(entryId: string, _label?: string): void {
            labelCalls.push(entryId);
          },
        }
      : {
          setLabel(next: string): void {
            if (options.failLabel) throw new Error("incompatible setLabel");
            label = next;
          },
        }),
    on(event: string, handler: (...args: unknown[]) => unknown): void {
      if (options.failSpawnHook && event === "before_subagent_spawn") {
        throw new Error("unsupported event");
      }
      if (options.failSessionHook && event === "session_start") {
        throw new Error("unsupported event");
      }
      if (options.failModelHook && event === "model_select") {
        throw new Error("unsupported event");
      }
      hooks.set(event, handler);
    },
    registerCommand(name: string, def: MockCommand): void {
      if (name === "model-sync") command = def;
    },
    ...(options.tools || options.failTools
      ? {
          getAllTools(): unknown[] {
            if (options.failTools) throw new Error("incompatible getAllTools");
            return options.tools ?? [];
          },
        }
      : {}),
  };

  modelSync(api as never);

  return {
    get label() {
      return label;
    },
    get labelCalls() {
      return labelCalls.slice();
    },
    hooks,
    statuses,
    command: () => {
      if (!command) throw new Error("model-sync command not registered");
      return command;
    },
    async runCommand(args: string, ctx: Record<string, unknown>) {
      const notifications: NotifyRecord[] = [];
      const baseUi =
        ctx.ui && typeof ctx.ui === "object" ? (ctx.ui as Record<string, unknown>) : {};
      const fullCtx = {
        ...ctx,
        hasUI: options.hasUI ?? ctx.hasUI ?? false,
        ui: {
          ...baseUi,
          notify(message: string, level: NotifyRecord["level"] = "info") {
            notifications.push({ message, level });
          },
          ...(options.select ? { select: options.select } : {}),
          ...(options.setStatus
            ? {
                setStatus(key: string, text: string | undefined) {
                  statuses.push({ key, text });
                  options.setStatus?.(key, text);
                },
              }
            : {}),
        },
      };
      await command?.handler(args, fullCtx);
      return notifications;
    },
    emitSpawn(event: Record<string, unknown>, ctx: Record<string, unknown>) {
      const handler = hooks.get("before_subagent_spawn");
      return handler ? handler(event, ctx) : undefined;
    },
    emitToolCall(event: Record<string, unknown>, ctx: Record<string, unknown>) {
      const handler = hooks.get("tool_call");
      return handler ? handler(event, ctx) : undefined;
    },
    emitSessionStart(ctx: Record<string, unknown>) {
      const handler = hooks.get("session_start");
      return handler ? handler({ type: "session_start", reason: "startup" }, ctx) : undefined;
    },
    emitModelSelect(ctx: Record<string, unknown>, model: unknown) {
      const handler = hooks.get("model_select");
      return handler ? handler({ type: "model_select", model }, ctx) : undefined;
    },
  };
}
