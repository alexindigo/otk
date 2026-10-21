// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandHub, ContextTarget } from "@otk/client";

interface TextTarget {
  text: string;
}
interface ImageTarget extends TextTarget {
  name: string;
}
interface EditTarget extends TextTarget {
  element: HTMLInputElement | HTMLTextAreaElement | HTMLElement;
  value: string;
  start?: number;
  end?: number;
  range?: Range;
  writable: boolean;
}
const textValue = (element: EditTarget["element"]) =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    ? element.value
    : element.textContent ?? "";
function restore(target: EditTarget): void {
  if (
    !target.element.isConnected || textValue(target.element) !== target.value
  ) {
    throw new Error("The field changed — open its menu again.");
  }
  target.element.focus();
  if (target.start !== undefined) {
    (target.element as HTMLInputElement | HTMLTextAreaElement)
      .setSelectionRange(target.start, target.end!);
  } else if (target.range) {
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(target.range);
  }
}
function replace(target: EditTarget, value: string): void {
  restore(target);
  // Native editing keeps undo and emits input through the ordinary field owner.
  if (!document.execCommand(value ? "insertText" : "delete", false, value)) {
    throw new Error("The browser couldn't edit this field from the menu.");
  }
}

/** Browser built-ins are contributed just like feature actions, never dispatched
 * by the menu view. Selections and edit ranges are captured before focus moves. */
export function browserContextTargets(
  path: readonly EventTarget[],
  declared: (element: HTMLElement) => ContextTarget[] = () => [],
  point?: { x: number; y: number },
): ContextTarget[] {
  const nodes = path.filter((node): node is HTMLElement =>
    node instanceof HTMLElement
  );
  const edit = nodes.find((node) =>
    node instanceof HTMLTextAreaElement ||
    (node instanceof HTMLInputElement && !node.disabled &&
      ["text", "search", "tel", "url", "email", "password", "number"].includes(
        node.type,
      )) ||
    (node.isContentEditable && !node.parentElement?.isContentEditable)
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
  if (edit) {
    const field =
      edit instanceof HTMLInputElement || edit instanceof HTMLTextAreaElement
        ? edit
        : undefined;
    const start = field?.selectionStart ?? undefined,
      end = field?.selectionEnd ?? undefined;
    const value = textValue(edit);
    targets.push({
      kind: "editable",
      data: {
        element: edit,
        value,
        text: start === undefined
          ? (!field && selectedHere ? selection?.toString() ?? "" : "")
          : value.slice(start, end),
        start,
        end,
        range: !field && selectedHere && selection?.rangeCount
          ? selection.getRangeAt(0).cloneRange()
          : undefined,
        writable: field ? !field.readOnly && !field.disabled : true,
      } satisfies EditTarget,
    });
  } else if (selectedHere) {
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
  for (const kind of ["selection", "editable"]) {
    releases.push(commands.register({
      id: `context.${kind}.copy`,
      title: "Copy",
      category: "Editing",
      hidden: true,
      context: { kind },
      enabled: (_ctx, target?: TextTarget) => !!target?.text,
      run: (_ctx, target: TextTarget) => copy(target),
    }));
  }
  releases.push(commands.register({
    id: "context.editable.cut",
    title: "Cut",
    category: "Editing",
    hidden: true,
    context: { kind: "editable", order: -10 },
    enabled: (_ctx, target?: EditTarget) => !!target?.writable && !!target.text,
    run: async (_ctx, target: EditTarget) => {
      await copy(target);
      replace(target, "");
    },
  }));
  releases.push(commands.register({
    id: "context.editable.paste",
    title: "Paste",
    category: "Editing",
    hidden: true,
    context: { kind: "editable" },
    enabled: (_ctx, target?: EditTarget) => !!target?.writable,
    run: async (_ctx, target: EditTarget) => {
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        throw new Error(
          "The browser didn't allow pasting from the menu — paste from the keyboard",
        );
      }
      if (text) replace(target, text);
    },
  }));
  releases.push(commands.register({
    id: "context.editable.selectAll",
    title: "Select all",
    category: "Editing",
    hidden: true,
    context: { kind: "editable" },
    run: (_ctx, target: EditTarget) => {
      restore(target);
      if (
        target.element instanceof HTMLInputElement ||
        target.element instanceof HTMLTextAreaElement
      ) {
        target.element.select();
      } else {
        const range = document.createRange(),
          selection = document.getSelection()!;
        range.selectNodeContents(target.element);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    },
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
