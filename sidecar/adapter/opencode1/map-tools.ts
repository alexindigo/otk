// SPDX-License-Identifier: LGPL-3.0-only
import type { ToolCall } from "../../../protocol/content.ts";
import type { RawPart } from "./types.ts";
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
export function mapTool(part: RawPart, awaitingPermission = false): ToolCall {
  const state = part.state!;
  const base = {
    callID: part.callID!,
    status: state.status,
    title: state.title,
    error: state.error,
    time: { start: state.time?.start, end: state.time?.end },
    awaitingPermission,
  };
  const input = state.input, metadata = state.metadata ?? {};
  if (part.tool === "bash") {
    return {
      ...base,
      tool: "bash",
      command: string(input.command) || "",
      description: string(input.description),
      cwd: string(input.workdir),
      output: string(metadata.output) ?? state.output ?? "",
      exitCode: typeof metadata.exit === "number" ? metadata.exit : undefined,
    };
  }
  return {
    ...base,
    tool: "generic",
    name: part.tool!,
    summary:
      Object.values(input).map(string).find((v) => v?.trim())?.split("\n")[0]
        .slice(0, 256) || part.tool!,
    output: state.output?.slice(0, 65_536),
    childSessionID: string(metadata.sessionId),
  };
}
