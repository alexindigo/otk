// SPDX-License-Identifier: LGPL-3.0-only
/** Process stdout is custody evidence: accept only the selected native's line. */
export function nativeListeningURL(
  output: string,
  kind: "opencode-v1" | "opencode-v2-server",
  hostname: "127.0.0.1" | "0.0.0.0" = "127.0.0.1",
): string | undefined {
  const prefix = kind === "opencode-v1" ? "opencode server" : "server";
  const expression = new RegExp(
    `^${prefix} listening on (http://${hostname.replaceAll(".", "\\.")}:\\d+)$`,
  );
  return output.split(/\r?\n/).flatMap((line) =>
    expression.exec(line)?.[1] ?? []
  ).at(-1);
}
