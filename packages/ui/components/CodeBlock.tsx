// SPDX-License-Identifier: LGPL-3.0-only
import "./CodeBlock.css" with { type: "text" };
import { type Element, Match, Switch } from "solid-js";
import type { CodeBlockSource } from "@otk/client";
import { useContentIdentity } from "../features/transcript-context.tsx";
import { contextTarget } from "./context-target.ts";
import Code from "./Code.tsx";
import MessageActions from "./MessageActions.tsx";

export default function CodeBlock(props: {
  source: CodeBlockSource;
  frame?: "own" | "inherit";
  textClass?: string;
  reveal?: boolean;
  header?: Element;
  children?: Element;
}): Element {
  const identity = useContentIdentity();
  const target = () => ({ ...identity, code: props.source });
  const highlighted = () => {
    const source = props.source;
    return source.kind === "fence" || source.kind === "file"
      ? source
      : undefined;
  };
  const plain = () => "text" in props.source ? props.source.text : "";
  return (
    <div
      class="otk-code-block"
      data-code-kind={props.source.kind}
      data-frame={props.frame ?? "own"}
      ref={contextTarget(() => ({ kind: "code", data: target() }))}
    >
      <Switch>
        <Match when={props.source.kind === "diff"}>
          <div class="otk-code-block-header">{props.header}</div>
          <div class="otk-code-block-rows">{props.children}</div>
        </Match>
        <Match when={highlighted()}>
          {(source) => (
            <div class="otk-code-block-body">
              <Code
                text={source().text}
                lang={source().lang}
                streaming={(source() as Extract<
                  CodeBlockSource,
                  { kind: "fence" }
                >).streaming}
                lineNumbers={source().kind === "file"}
                startLine={(source() as Extract<
                  CodeBlockSource,
                  { kind: "file" }
                >).startLine}
                revealFence={props.reveal}
              />
            </div>
          )}
        </Match>
        <Match when>
          <div class="otk-code-block-body">
            <pre
              class={["otk-code-block-text", props.textClass]}
            >{props.children ?? plain()}</pre>
          </div>
        </Match>
      </Switch>
      <div class="otk-code-block-actions">
        <MessageActions kind="code" target={target()} failure="marker" />
      </div>
    </div>
  );
}
