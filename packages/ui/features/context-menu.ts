// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub, ContextTarget } from "@otk/client";

interface TextTarget {
  text: string;
}
interface ImageTarget extends TextTarget {
  name: string;
}
/** Text-field menus belong to the browser, including its spelling/dictionary UI. */
export function nativeTextContext(path: readonly EventTarget[]): boolean {
  return path.some((node) =>
    node instanceof HTMLTextAreaElement ||
    (node instanceof HTMLInputElement &&
      ["text", "search", "tel", "url", "email", "password", "number"].includes(
        node.type,
      )) ||
    (node instanceof HTMLElement && node.isContentEditable)
  );
}

/** Browser built-ins are contributed just like feature actions, never dispatched
 * by the menu view. Non-field selections are captured before focus moves. */
export function browserContextTargets(
  path: readonly EventTarget[],
  declared: (element: HTMLElement) => ContextTarget[] = () => [],
  point?: { x: number; y: number },
): ContextTarget[] {
  if (nativeTextContext(path)) return [];
  const nodes = path.filter((node): node is HTMLElement =>
    node instanceof HTMLElement
  );
  const selection = document.getSelection();
  const targets: ContextTarget[] = [];
  const selectedHere = !!selection?.toString() &&
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
  if (selectedHere) {
    targets.push({ kind: "selection", data: { text: selection!.toString() } });
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
    targets.push(...declared(node));
  }
  return targets;
}

export function registerBrowserContextCommands(
  commands: CommandHub,
): () => void {
  const releases: (() => void)[] = [];
  const copy = (target: TextTarget) =>
    navigator.clipboard.writeText(target.text);
  releases.push(commands.register({
    id: "context.selection.copy",
    title: "Copy",
    category: "Editing",
    hidden: true,
    context: { kind: "selection" },
    enabled: (_ctx, target?: TextTarget) => !!target?.text,
    run: (_ctx, target: TextTarget) => copy(target),
  }));
  releases.push(commands.register({
    id: "context.link.open",
    title: "Open link in new tab",
    category: "Browser",
    hidden: true,
    context: { kind: "link" },
    run: (_ctx, target: TextTarget) => {
      globalThis.open(target.text, "_blank", "noopener,noreferrer");
    },
  }));
  releases.push(commands.register({
    id: "context.image.open",
    title: "Open image",
    category: "Browser",
    hidden: true,
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
      hidden: true,
      context: { kind },
      run: (_ctx, target: TextTarget) => copy(target),
    }));
  }
  return () => releases.forEach((release) => release());
}
