// SPDX-License-Identifier: LGPL-3.0-only
import "./Blocks.css" with { type: "text" };
import { For, Match, Show, Switch } from "solid-js";
import { dynamic } from "@solidjs/web";
import type { Block, Inline } from "@otk/protocol";
import HighlightedCode from "./Code.tsx";
const blockOf = <K extends Block["b"]>(block: Block, kind: K) =>
  block.b === kind ? block as Block & { b: K } : undefined;
const inlineOf = <K extends Inline["i"]>(inline: Inline, kind: K) =>
  inline.i === kind ? inline as Inline & { i: K } : undefined;
function safeHref(href: string): string | undefined {
  try {
    return ["http:", "https:", "mailto:"].includes(
        new URL(href, location.href).protocol,
      )
      ? href
      : undefined;
  } catch {
    return;
  }
}
export function Inlines(props: { items: Inline[] }) {
  return (
    <For each={props.items} keyed={false}>
      {(item) => <InlineView item={item()} />}
    </For>
  );
}
type InlineProps<K extends Inline["i"]> = { item: Inline & { i: K } };
function TextInline(props: InlineProps<"text">) {
  return <>{props.item.text}</>;
}
function CodeInline(props: InlineProps<"code">) {
  return <code class="otk-prose-code">{props.item.text}</code>;
}
function StrongInline(props: InlineProps<"strong">) {
  return (
    <strong class="otk-prose-strong">
      <Inlines items={props.item.inline} />
    </strong>
  );
}
function EmInline(props: InlineProps<"em">) {
  return (
    <em class="otk-prose-em">
      <Inlines items={props.item.inline} />
    </em>
  );
}
function DelInline(props: InlineProps<"del">) {
  return (
    <del class="otk-prose-del">
      <Inlines items={props.item.inline} />
    </del>
  );
}
function LinkInline(props: InlineProps<"link">) {
  return (
    <a
      class="otk-prose-link"
      href={safeHref(props.item.href)}
      target="_blank"
      rel="noopener noreferrer"
    >
      <Inlines items={props.item.inline} />
    </a>
  );
}
function ImageInline(props: InlineProps<"image">) {
  return (
    <img
      class="otk-prose-image"
      src={props.item.src.startsWith("data:image/")
        ? props.item.src
        : safeHref(props.item.src)}
      alt={props.item.alt}
      loading="lazy"
    />
  );
}
function BreakInline() {
  return <br />;
}
function InlineView(props: { item: Inline }) {
  return (
    <Switch>
      <Match when={inlineOf(props.item, "text")}>
        {(item) => <TextInline item={item()} />}
      </Match>
      <Match when={inlineOf(props.item, "code")}>
        {(item) => <CodeInline item={item()} />}
      </Match>
      <Match when={inlineOf(props.item, "strong")}>
        {(item) => <StrongInline item={item()} />}
      </Match>
      <Match when={inlineOf(props.item, "em")}>
        {(item) => <EmInline item={item()} />}
      </Match>
      <Match when={inlineOf(props.item, "del")}>
        {(item) => <DelInline item={item()} />}
      </Match>
      <Match when={inlineOf(props.item, "link")}>
        {(item) => <LinkInline item={item()} />}
      </Match>
      <Match when={inlineOf(props.item, "image")}>
        {(item) => <ImageInline item={item()} />}
      </Match>
      <Match when={inlineOf(props.item, "break")}>
        <BreakInline />
      </Match>
    </Switch>
  );
}
function Paragraph(props: { block: Block & { b: "paragraph" } }) {
  return (
    <p class="otk-prose-paragraph">
      <Inlines items={props.block.inline} />
    </p>
  );
}
function Heading(props: { block: Block & { b: "heading" } }) {
  const Tag = dynamic(() =>
    `h${props.block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  );
  return (
    <Tag class="otk-prose-heading">
      <Inlines items={props.block.inline} />
    </Tag>
  );
}
function Code(
  props: {
    block: Block & { b: "code" };
    streaming?: boolean;
    conceal?: boolean;
  },
) {
  return (
    <HighlightedCode
      text={props.block.text}
      lang={props.block.lang}
      streaming={props.streaming}
      revealFence={props.conceal === false}
    />
  );
}
function List(props: { block: Block & { b: "list" }; conceal?: boolean }) {
  const Tag = dynamic(() => props.block.ordered ? "ol" : "ul");
  return (
    <Tag start={props.block.ordered ? props.block.start : undefined}>
      <For each={props.block.items} keyed={false}>
        {(item) => (
          <li>
            <Show when={item().task}>
              <input
                class="otk-prose-task"
                type="checkbox"
                checked={item().checked}
                disabled
                aria-label="Task"
              />
            </Show>
            <BlockList blocks={item().blocks} conceal={props.conceal} />
          </li>
        )}
      </For>
    </Tag>
  );
}
function Quote(props: { block: Block & { b: "quote" }; conceal?: boolean }) {
  return (
    <blockquote class="otk-prose-quote">
      <BlockList blocks={props.block.blocks} conceal={props.conceal} />
    </blockquote>
  );
}
function Table(props: { block: Block & { b: "table" } }) {
  return (
    <div class="otk-table-scroll">
      <table>
        <thead>
          <tr>
            <For each={props.block.header} keyed={false}>
              {(cell, index) => (
                <th
                  style={{ "text-align": props.block.align[index] ?? "left" }}
                >
                  <Inlines items={cell()} />
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.block.rows} keyed={false}>
            {(row) => (
              <tr>
                <For each={row()} keyed={false}>
                  {(cell, index) => (
                    <td
                      style={{
                        "text-align": props.block.align[index] ?? "left",
                      }}
                    >
                      <Inlines items={cell()} />
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
function Rule() {
  return <hr class="otk-prose-rule" />;
}
function BlockView(
  props: { block: Block; streaming?: boolean; conceal?: boolean },
) {
  return (
    <Switch>
      <Match when={blockOf(props.block, "paragraph")}>
        {(block) => <Paragraph block={block()} />}
      </Match>
      <Match when={blockOf(props.block, "heading")}>
        {(block) => <Heading block={block()} />}
      </Match>
      <Match when={blockOf(props.block, "code")}>
        {(block) => (
          <Code
            block={block()}
            streaming={props.streaming}
            conceal={props.conceal}
          />
        )}
      </Match>
      <Match when={blockOf(props.block, "list")}>
        {(block) => <List block={block()} conceal={props.conceal} />}
      </Match>
      <Match when={blockOf(props.block, "quote")}>
        {(block) => <Quote block={block()} conceal={props.conceal} />}
      </Match>
      <Match when={blockOf(props.block, "table")}>
        {(block) => <Table block={block()} />}
      </Match>
      <Match when={blockOf(props.block, "rule")}>
        <Rule />
      </Match>
    </Switch>
  );
}
function BlockList(
  props: { blocks: Block[]; streaming?: boolean; conceal?: boolean },
): import("solid-js").Element {
  return (
    <For each={props.blocks} keyed={false}>
      {(block, index) => (
        <BlockView
          block={block()}
          streaming={props.streaming && index === props.blocks.length - 1}
          conceal={props.conceal}
        />
      )}
    </For>
  );
}

/** Own prose paint and presentation; recursive blocks share this single boundary. */
export default function Blocks(props: {
  blocks: Block[];
  streaming?: boolean;
  conceal?: boolean;
  compact?: boolean;
}): import("solid-js").Element {
  return (
    <div
      class={["otk-text", {
        "otk-prose-unconcealed": props.conceal === false,
        "otk-prose-compact": props.compact,
      }]}
    >
      <BlockList
        blocks={props.blocks}
        streaming={props.streaming}
        conceal={props.conceal}
      />
    </div>
  );
}
