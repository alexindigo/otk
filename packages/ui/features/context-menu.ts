// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub, ContextTarget } from "@otk/client";
import { copyText } from "../clipboard.ts";
import type { ContextInvocation } from "../components/context-target.ts";
import { nativeTextField } from "../keyboard/ownership.ts";

interface TextTarget {
  text: string;
}
interface ImageTarget extends TextTarget {
  name: string;
}
/** Text-field menus belong to the browser, including its spelling/dictionary UI. */
export function nativeTextContext(path: readonly EventTarget[]): boolean {
  return path.some(nativeTextField);
}

/** Browser built-ins are contributed just like feature actions, never dispatched
 * by the menu view. Non-field selections are captured before focus moves. */
export function browserContextTargets(
  path: readonly EventTarget[],
  declared: (
    element: HTMLElement,
    invocation: ContextInvocation,
  ) => ContextTarget[] = () => [],
  point?: { x: number; y: number },
): ContextTarget[] {
  if (nativeTextContext(path)) return [];
  const nodes = path.filter((node): node is HTMLElement =>
    node instanceof HTMLElement
  );
  const selection = document.getSelection();
  const targets: ContextTarget[] = [];
  const text = selection?.toString() ?? "";
  const selectedHere = !!text && selection &&
    Array.from(
      { length: selection.rangeCount },
      (_, index) => selection.getRangeAt(index),
    ).some((range) =>
      point
        ? [...range.getClientRects()].some((rect) =>
          point.x >= rect.left && point.x <= rect.right &&
          point.y >= rect.top && point.y <= rect.bottom
        )
        : !!nodes[0] && selection.containsNode(nodes[0], true)
    );
  const selectedText = selectedHere ? text : "";
  if (selectedText) {
    targets.push({ kind: "selection", data: { text: selectedText } });
  }
  for (const node of nodes) {
    if (node instanceof HTMLAnchorElement && node.href) {
      targets.push({ kind: "link", data: { text: node.href } });
    }
    if (node instanceof HTMLImageElement && (node.currentSrc || node.src)) {
      targets.push({
        kind: "image",
        data: { text: node.currentSrc || node.src, name: node.alt || "Image" },
      });
    }
    targets.push(
      ...declared(node, { selection: selectedText, inner: targets.slice() }),
    );
  }
  return targets;
}

export function registerBrowserContextCommands(
  commands: CommandHub,
): () => void {
  const releases: (() => void)[] = [];
  const copy = (target: TextTarget) => copyText(target.text);
  releases.push(commands.register({
    id: "context.selection.copy",
    title: "Copy",
    category: "Editing",
    arguments: { type: "object", properties: { text: { type: "string" } } },
    context: { kind: "selection" },
    enabled: (_ctx, target?: TextTarget) => !!target?.text,
    run: (_ctx, target: TextTarget) => copy(target),
  }));
  releases.push(commands.register({
    id: "context.link.open",
    title: "Open link in new tab",
    category: "Browser",
    arguments: { type: "object", properties: { text: { type: "string" } } },
    context: { kind: "link" },
    run: (_ctx, target: TextTarget) => {
      globalThis.open(target.text, "_blank", "noopener,noreferrer");
    },
  }));
  releases.push(commands.register({
    id: "context.image.open",
    title: "Open image",
    category: "Browser",
    arguments: {
      type: "object",
      properties: { text: { type: "string" }, name: { type: "string" } },
    },
    context: { kind: "image" },
    enabled: () => commands.enabled("dialog.open", undefined, { id: "image" }),
    run: (_ctx, target: ImageTarget) =>
      commands.run("dialog.open", {
        id: "image",
        input: { name: target.name, url: target.text },
      }),
  }));
  for (
    const [kind, copyTitle] of [["link", "Copy link address"], [
      "image",
      "Copy image address",
    ]]
  ) {
    releases.push(commands.register({
      id: `context.${kind}.copy`,
      title: copyTitle,
      category: "Browser",
      arguments: { type: "object", properties: { text: { type: "string" } } },
      context: { kind },
      run: (_ctx, target: TextTarget) =>
        copyText(target.text, {
          actionLabel: copyTitle,
          target: kind === "link" ? "Link address" : "Image address",
          recovery: kind === "link"
            ? "Hold Shift and right-click the link, then choose Copy link address in the browser's link menu."
            : "Choose Open image, then use the browser's image menu (Shift+right-click) to copy the image address.",
        }),
    }));
  }
  return () => releases.forEach((release) => release());
}
