// SPDX-License-Identifier: LGPL-3.0-only
import {
  OperationFailure,
  type ProjectEditCapability,
  type ProjectEditSnapshot,
} from "@otk/protocol";
import { HarnessError } from "@otk/harness";
import type { V2Client } from "./client.ts";
import { projectColors } from "./project-presentation.ts";
type NativeProject = {
  id: string;
  name?: string;
  icon?: { override?: string; color?: string; url?: string };
  commands?: { start?: string };
};
function snapshot(
  project: NativeProject,
  directory: string,
): ProjectEditSnapshot {
  return {
    directory,
    projectID: project.id,
    iconSource: project.icon?.url,
    values: {
      name: project.name ?? "",
      icon: project.icon?.override ?? "",
      color: project.icon?.color ?? "",
      startScript: project.commands?.start ?? "",
    },
    fields: ["name", "icon", "color", "startScript"],
    colors: Object.entries(projectColors).filter(([name]) =>
      !["mint", "lime"].includes(name)
    ).map(([value, color]) => ({
      value,
      color,
      label: value[0].toUpperCase() + value.slice(1),
    })),
    hints: [{
      variable: "$OPENCODE_WORKTREE_BASE",
      description: "Base worktree",
    }, { variable: "$OPENCODE_WORKTREE_PATH", description: "New worktree" }],
  };
}
export function projectEditor(
  client: () => V2Client,
  changed: () => void,
): ProjectEditCapability {
  return {
    async read(directory, signal) {
      const c = client();
      const location = await c.read(
        (api) => api.location.get({ location: { directory } }, { signal }),
        signal,
      );
      const projects = await c.read(
        (api) => api.project.list({ archived: true }, { signal }),
        signal,
      );
      const project = projects.find((project) =>
        project.id === location.project.id
      );
      if (!project) {
        throw new HarnessError(
          "project.missing",
          "That project is no longer available.",
        );
      }
      return snapshot(project, directory);
    },
    async update(target, patch, operation) {
      const c = client();
      const location = await c.read(
        (api) =>
          api.location.get({ location: { directory: target.directory } }, {
            signal: operation?.signal,
          }),
        operation?.signal,
      );
      if (location.project.id !== target.projectID) {
        throw new OperationFailure(
          "rejected",
          "project.target",
          new Error("Project changed"),
          {
            reason:
              "The folder now belongs to another project. Reopen project settings.",
          },
        );
      }
      await c.effect((api) =>
        api.project.update({
          projectID: target.projectID,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.icon === undefined && patch.color === undefined ? {} : {
            icon: {
              ...(patch.icon === undefined ? {} : { override: patch.icon }),
              ...(patch.color === undefined ? {} : { color: patch.color }),
            },
          }),
          ...(patch.startScript === undefined
            ? {}
            : { commands: { start: patch.startScript } }),
        }), operation);
      const projects = await c.read(
        (api) =>
          api.project.list({ archived: true }, { signal: operation?.signal }),
        operation?.signal,
      ).catch((cause) => {
        throw new OperationFailure("unknown", "project.readback", cause);
      });
      const project = projects.find((project) =>
        project.id === target.projectID
      );
      if (!project) {
        throw new OperationFailure(
          "unknown",
          "project.readback",
          new Error("Project missing after write"),
        );
      }
      const result = snapshot(project, target.directory);
      if (
        Object.entries(patch).some(([field, value]) =>
          result.values[field as keyof typeof result.values] !== value
        )
      ) {
        throw new OperationFailure(
          "unknown",
          "project.readback",
          new Error("Native project readback differs"),
        );
      }
      changed();
      return result;
    },
  };
}
