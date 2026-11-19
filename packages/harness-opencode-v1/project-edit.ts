// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import {
  OperationFailure,
  type ProjectEditCapability,
  type ProjectEditField,
  type ProjectEditSnapshot,
} from "@otk/protocol";
import type { Client } from "./client.ts";
import { projectColors, readNativeProject } from "./project-presentation.ts";
/** Capabilities come from this installed server's API schema, not the V1 label. */
export function writableProjectFields(
  doc: {
    paths?: Record<
      string,
      {
        patch?: {
          requestBody?: {
            content?: Record<
              string,
              { schema?: { properties?: Record<string, unknown> } }
            >;
          };
        };
      }
    >;
  },
): ProjectEditField[] {
  const properties =
    doc.paths?.["/project/{projectID}"]?.patch?.requestBody?.content
      ?.["application/json"]?.schema?.properties ?? {};
  return [
    ...("name" in properties ? ["name" as const] : []),
    ...("icon" in properties ? ["icon" as const, "color" as const] : []),
    ...("commands" in properties ? ["startScript" as const] : []),
  ];
}
export function projectEditor(
  client: Client,
  changed: () => void,
): ProjectEditCapability {
  const read = async (
    directory: string,
    signal?: AbortSignal,
  ): Promise<ProjectEditSnapshot> => {
    const [project, doc] = await Promise.all([
      readNativeProject(client, directory, signal),
      client.json<Parameters<typeof writableProjectFields>[0]>("/doc", {
        signal,
      }),
    ]);
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
      fields: writableProjectFields(doc),
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
  };
  return {
    read,
    async update(target, patch, operation) {
      const before = await read(target.directory, operation?.signal);
      if (
        before.projectID !== target.projectID ||
        Object.keys(patch).some((field) =>
          !before.fields.includes(field as ProjectEditField)
        )
      ) {
        throw new HarnessError(
          "project.target",
          "The project or its writable fields changed. Reopen project settings.",
        );
      }
      await client.json(`/project/${encodeURIComponent(target.projectID)}`, {
        method: "PATCH",
        query: { directory: target.directory },
        operation,
        body: {
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
        },
      });
      const result = await read(target.directory, operation?.signal).catch(
        (cause) => {
          throw new OperationFailure("unknown", "project.readback", cause);
        },
      );
      if (
        result.projectID !== target.projectID ||
        Object.entries(patch).some(([field, value]) =>
          result.values[field as ProjectEditField] !== value
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
