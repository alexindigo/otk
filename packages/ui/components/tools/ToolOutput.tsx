// SPDX-License-Identifier: LGPL-3.0-only
import "./ToolOutput.css" with { type: "text" };
import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { ToolResult } from "@otk/protocol";
import { ownedAction } from "../../keyboard/context.tsx";
import Code from "../Code.tsx";
import ToolPath from "./ToolPath.tsx";
import { relativeTarget } from "./paths.ts";
import { countLabel } from "./count.ts";
export default function ToolOutput(
  props: {
    text: string;
    limit: number;
    result?: ToolResult;
    directory?: string;
  },
): import("solid-js").Element {
  const [open, setOpen] = createSignal(false);
  const toggle = ownedAction(
    "tool.output.toggle",
    () => setOpen((value) => !value),
  );
  const text = () => {
    const result = props.result;
    if (result?.kind === "paths") {
      return result.paths.map((path) => relativeTarget(path, props.directory))
        .join("\n") || "No results";
    }
    if (result?.kind === "text") return result.text;
    return props.text;
  };
  const lines = () => text().trimEnd().split("\n");
  const file = () => props.result?.kind === "file" ? props.result : undefined;
  const matches = () =>
    props.result?.kind === "matches" ? props.result : undefined;
  const skill = () => props.result?.kind === "skill" ? props.result : undefined;
  const pathMeta = () => {
    const result = props.result;
    if (
      result?.kind !== "paths" ||
      (!result.truncated && (result.offset ?? 1) === 1)
    ) return "";
    const range = result.total !== undefined && result.offset !== undefined
      ? result.paths.length
        ? `${result.offset}–${result.offset + result.paths.length - 1} of ${
          countLabel(result.total, "entry", "entries")
        }`
        : `Offset ${result.offset} · ${
          countLabel(result.total, "entry", "entries")
        } total`
      : "";
    return [range, result.truncated ? "More available" : ""].filter(Boolean)
      .join(" · ");
  };
  return (
    <Switch
      fallback={
        <>
          <Show when={text()}>
            <pre class="otk-tool-output">{open()?text().trimEnd():lines().slice(0,props.limit).join("\n")}</pre>
            <Show when={lines().length > props.limit}>
              <button
                class="otk-output-toggle"
                type="button"
                aria-expanded={open() ? "true" : "false"}
                onClick={() => void toggle()}
              >
                {open() ? "Collapse output" : "Expand output"}
              </button>
            </Show>
          </Show>
          <Show when={pathMeta()}>
            <small class="otk-muted" data-tool-result-meta>
              {pathMeta()}
            </small>
          </Show>
        </>
      }
    >
      <Match when={file()}>
        {(result) => (
          <>
            <Show
              when={result().endLine >= result().startLine}
              fallback={<p class="otk-muted">No lines returned</p>}
            >
              <Code
                text={result().text}
                lang={result().lang}
                lineNumbers
                startLine={result().startLine}
              />
            </Show>
            <small class="otk-muted" data-tool-result-meta>
              {result().endLine >= result().startLine
                ? `${result().startLine}–${result().endLine}`
                : ""}
              {result().totalLines !== undefined
                ? `${result().endLine >= result().startLine ? " of " : ""}${
                  countLabel(result().totalLines!, "line")
                }${result().endLine >= result().startLine ? "" : " total"}`
                : ""}
              {result().truncated ? " · More available" : ""}
            </small>
          </>
        )}
      </Match>
      <Match when={matches()}>
        {(result) => (
          <>
            <For each={result().matches} keyed={false}>
              {(match) => (
                <pre
                  class="otk-tool-output"
                  data-tool-match
                ><ToolPath path={match().path} directory={props.directory} />:{match().line}: {match().text}</pre>
              )}
            </For>
            <Show when={!result().matches.length}>
              <p class="otk-muted">No matches</p>
            </Show>
            <Show when={result().truncated}>
              <small class="otk-muted" data-tool-result-meta>
                More matches available
              </small>
            </Show>
          </>
        )}
      </Match>
      <Match when={skill()}>
        {(result) => (
          <>
            <pre class="otk-tool-output">{result().text}</pre>
            <p class="otk-muted">
              Base directory:{" "}
              <ToolPath path={result().directory} directory={props.directory} />
            </p>
            <For each={result().paths} keyed={false}>
              {(path) => (
                <div>
                  <ToolPath path={path()} directory={props.directory} />
                </div>
              )}
            </For>
          </>
        )}
      </Match>
    </Switch>
  );
}
