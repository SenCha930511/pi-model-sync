export function quoteBatchArgument(value) {
  if (/["%\r\n]/u.test(value)) {
    throw new Error("Windows batch arguments may not contain quotes, percent signs, or newlines");
  }
  return `"${value}"`;
}

export function resolveCommandProbe(file, args = [], platform = process.platform) {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(file)) {
    return { command: file, args: [...args] };
  }
  if (/["%\r\n]/u.test(file)) {
    throw new Error("Windows batch executable paths may not contain quotes, percent signs, or newlines");
  }
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/e:on", "/v:off", "/c", `call "${file}"`, ...args.map(quoteBatchArgument)],
  };
}
