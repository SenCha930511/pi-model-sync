declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    setLabel?(label: string): void;
    on(event: string, handler: (...args: never[]) => unknown): void;
    registerCommand(name: string, options: {
      description: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null;
      handler: (args: string, ctx: never) => Promise<void> | void;
    }): void;
  }
}
