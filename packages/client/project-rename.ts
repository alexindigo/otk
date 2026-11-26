// SPDX-License-Identifier: LGPL-3.0-only
import { failureValue } from "./failure-features.ts";
import { createInlineRename, type InlineRename } from "./inline-rename.ts";
import type { StateFactory } from "./state.ts";

export interface ProjectRenameTarget {
  sidecarId: string;
  directory: string;
  projectID: string;
  title: string;
}

export interface ProjectRename extends InlineRename<ProjectRenameTarget> {
  reset(target: ProjectRenameTarget): Promise<void>;
}

export function createProjectRename(o: {
  update(target: ProjectRenameTarget, name: string): Promise<unknown>;
  label(target: ProjectRenameTarget): string | undefined;
  factory?: StateFactory;
}): ProjectRename {
  const owner = createInlineRename<ProjectRenameTarget>({
    same: (a, b) =>
      a.sidecarId === b.sidecarId && a.directory === b.directory &&
      a.projectID === b.projectID,
    rename: o.update,
    current: o.label,
    factory: o.factory,
    validate: (name) =>
      name
        ? undefined
        : "Enter a name. Reset name in the row menu restores the folder name.",
    failure: (error, target) =>
      failureValue(error, {
        action: "project.rename",
        actionLabel: "Renaming project",
        target: {
          directory: target.directory,
          label: target.title,
          sidecarId: target.sidecarId,
        },
        reason: "Couldn't rename the project.",
      }),
  });
  return {
    ...owner,
    // Once submitted, Escape or a second row's Rename cannot dismiss an
    // outcome that may still be in flight. Only an unsent draft can cancel.
    start(target) {
      if (!owner.state.pending) owner.start(target);
    },
    cancel() {
      if (!owner.state.pending) owner.cancel();
    },
    async reset(target) {
      await o.update(target, "");
    },
  };
}
