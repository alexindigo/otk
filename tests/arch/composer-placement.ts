// SPDX-License-Identifier: LGPL-3.0-only
import { Source } from "./analysis.ts";

/** Follow borrowed notice components as well as directly mounted composer slots. */
export function composerInTranscriptErrors(
  files: ReadonlyMap<string, string>,
): string[] {
  const notices = new Set([
    "ComposerNotice",
    "ComposerNoticeRow",
    "ComposerTakeovers",
    "RevertSendChoice",
  ]);
  const sources = [...files].filter(([path]) => path.endsWith(".tsx")).map((
    [path, text],
  ) => new Source(text, path));
  for (const source of sources) {
    for (const node of source.all) {
      if (
        node.type !== "JSXOpeningElement" ||
        !notices.has(source.name(node.name) ?? "")
      ) continue;
      let parent = source.parent.get(node);
      while (parent && parent.type !== "FunctionDeclaration") {
        parent = source.parent.get(parent);
      }
      if (parent?.type === "FunctionDeclaration" && parent.id) {
        notices.add(
          parent.id.name,
        );
      }
    }
  }
  const errors: string[] = [];
  for (const source of sources) {
    for (const node of source.all) {
      if (
        node.type !== "JSXOpeningElement" ||
        !notices.has(source.name(node.name) ?? "")
      ) continue;
      let parent = source.parent.get(node);
      while (parent) {
        if (
          parent.type === "JSXElement" &&
          parent.openingElement.attributes.some((a) =>
            a.type === "JSXAttribute" && a.name.name === "class" &&
            /\botk-message-flow\b/.test(source.string(a.value) ?? "")
          )
        ) {
          errors.push(
            `${source.path}: ${
              source.name(node.name)
            } belongs to the composer, not the transcript`,
          );
          break;
        }
        parent = source.parent.get(parent);
      }
    }
  }
  return errors;
}
