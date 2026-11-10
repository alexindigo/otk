// SPDX-License-Identifier: LGPL-3.0-only
/** Process stdout is custody evidence: accept only the selected native's line. */
export function nativeListeningURL(
  output: string,
  kind: "opencode-v1" | "opencode-v2-server",
): string | undefined {
  const prefix = kind === "opencode-v1" ? "opencode server" : "server";
  const expression = new RegExp(
    `^${prefix} listening on (http://127\\.0\\.0\\.1:\\d+)$`,
  );
  return output.split(/\r?\n/).flatMap((line) =>
    expression.exec(line)?.[1] ?? []
  ).at(-1);
}
