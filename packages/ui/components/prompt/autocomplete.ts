// SPDX-License-Identifier: LGPL-3.0-only
import fuzzysort from "fuzzysort";
import { frecency } from "@otk/protocol";
import type {
  AgentOption,
  CommandOption,
  FileMatch,
  FrecencyEntry,
  ResourceOption,
} from "@otk/protocol";
import type { CompletionOption } from "@otk/client";
export type { CompletionOption } from "@otk/client";
export interface MentionSources {
  files: FileMatch[];
  agents: AgentOption[];
  resources: ResourceOption[];
  frecency: FrecencyEntry[];
  directory: string;
}
export interface Completion {
  kind: "mention" | "slash";
  start: number;
  end: number;
  query: string;
}
export function trigger(input: string, caret: number): Completion | undefined {
  const before = input.slice(0, caret);
  if (/^\/[^\s]*$/.test(before)) {
    return { kind: "slash", start: 0, end: caret, query: before.slice(1) };
  }
  const token = mention(input, caret);
  return token ? { ...token, kind: "mention" } : undefined;
}
export function commandOptions(
  commands: CommandOption[],
  query: string,
): CompletionOption[] {
  return rank(
    [
      ...commands,
    ].map((command) => ({
      id: `command:${command.name}`,
      label: `/${command.name}${command.source === "mcp" ? ":mcp" : ""}`,
      description: command.description,
      aliases: command.aliases,
      command,
    })),
    query,
    [],
    "",
    true,
  );
}
export function parseCommand(
  input: string,
): { command: string; arguments: string } | undefined {
  if (!input.startsWith("/")) return;
  const end = input.indexOf("\n"),
    first = end < 0 ? input : input.slice(0, end),
    [name, ...args] = first.split(" "),
    rest = end < 0 ? "" : input.slice(end + 1);
  return {
    command: name.slice(1),
    arguments: args.join(" ") + (rest ? "\n" + rest : ""),
  };
}
export function mention(
  input: string,
  caret: number,
): { start: number; end: number; query: string } | undefined {
  const before = input.slice(0, caret),
    match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  return match
    ? { start: caret - match[1].length - 1, end: caret, query: match[1] }
    : undefined;
}
export function mentionQuery(
  value: string,
): { query: string; range?: { start: number; end?: number } } {
  const hash = value.lastIndexOf("#");
  if (hash < 0) return { query: value };
  const query = value.slice(0, hash);
  const match = /^(\d+)(?:-(\d*))?$/.exec(value.slice(hash + 1));
  if (!match) return { query };
  const start = Number(match[1]);
  const end = match[2] && start < Number(match[2])
    ? Number(match[2])
    : undefined;
  return { query, range: { start, ...(end === undefined ? {} : { end }) } };
}
export function rank(
  options: CompletionOption[],
  query: string,
  entries: FrecencyEntry[] = [],
  directory = "",
  descriptions = false,
): CompletionOption[] {
  const score = (path?: string) =>
    path
      ? frecency(
        entries.find((entry) =>
          entry.path === (path.startsWith("/")
            ? path
            : `${directory.replace(/\/$/, "")}/${path}`)
        ),
      )
      : 0;
  if (!query) {
    return [...options].sort((a, b) =>
      score(b.path) - score(a.path) || a.label.localeCompare(b.label)
    ).slice(0, 10);
  }
  return fuzzysort.go(query, options, {
    keys: [
      (option) => option.label,
      (option) => descriptions ? option.description || "" : "",
      (option) => option.aliases?.join(" ") || "",
    ],
    threshold: descriptions ? 0 : .5,
    limit: 10,
    scoreFn: (result) =>
      result.score *
      (result[0]?.target.startsWith(result.obj.command ? `/${query}` : query)
        ? 2
        : 1) *
      (1 + score(result.obj.path)),
  }).map((result) => result.obj);
}
export function mentionOptions(
  source: MentionSources,
  value: string,
): CompletionOption[] {
  const { query, range } = mentionQuery(value);
  return rank(
    [
      ...source.files.map((file) => ({
        id: `file:${file.path}`,
        label: file.path +
          (range && !file.directory
            ? `#${range.start}${range.end === undefined ? "" : `-${range.end}`}`
            : ""),
        path: file.path,
        directory: file.directory,
        part: {
          kind: "file" as const,
          source: "path" as const,
          path: file.path,
          ...(range && !file.directory ? { range } : {}),
        },
      })),
      ...source.agents.map((agent) => ({
        id: `agent:${agent.name}`,
        label: agent.name,
        description: agent.description,
        part: { kind: "agent" as const, name: agent.name },
      })),
      ...source.resources.map((resource) => ({
        id: `resource:${resource.server}:${resource.uri}`,
        label: resource.name,
        description: resource.description,
        part: {
          kind: "file" as const,
          source: "resource" as const,
          ...resource,
        },
      })),
    ],
    query,
    source.frecency,
    source.directory,
  );
}
