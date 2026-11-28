// SPDX-License-Identifier: LGPL-3.0-only
import { basename, isAbsolute, normalize } from "@std/path/posix";
import { type ProjectTopology, UNKNOWN_REPOSITORY } from "@otk/protocol";

export interface CheckoutTopology {
  topology(directory: string): ProjectTopology | undefined;
  topologies(): ProjectTopology[];
  availability(
    directory: string,
  ): "present" | "removed" | "unknown" | undefined;
}

/** Expand operator templates with the same checkout authority as the inbox. */
export class ImageRoots {
  constructor(
    private readonly options: {
      templates: readonly string[];
      home: string;
      identity: CheckoutTopology;
    },
  ) {}

  roots(directory: string): string[] {
    if (!isAbsolute(directory)) return [];
    const { home, identity, templates } = this.options;
    const root = identity.topology(directory)?.canonicalRoot;
    const canonical = root && root !== UNKNOWN_REPOSITORY ? root : directory;
    const project = basename(canonical);
    const paths = new Set<string>();
    const add = (path: string) => {
      if (isAbsolute(path)) paths.add(normalize(path));
    };
    for (const template of templates) {
      if (template === "{checkouts}") {
        add(directory);
        add(canonical);
        if (root && root !== UNKNOWN_REPOSITORY) {
          for (const checkout of identity.topologies()) {
            if (
              checkout.canonicalRoot === canonical &&
              identity.availability(checkout.leafDirectory) !== "removed"
            ) {
              add(checkout.leafDirectory);
            }
          }
        }
      } else {
        const components = template.split("/");
        if (
          components.includes("{project}") &&
          (!project || project.startsWith("."))
        ) continue;
        if (components[0] === "~") {
          if (!isAbsolute(home)) continue;
          components[0] = home === "/" ? "" : home.replace(/\/$/, "");
        }
        add(
          components.map((part) => part === "{project}" ? project : part).join(
            "/",
          ),
        );
      }
    }
    return [...paths];
  }
}
