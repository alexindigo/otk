// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import {
  OperationFailure,
  type ProjectEditCapability,
  type ProjectEditField,
  type ProjectEditSnapshot,
} from "@otk/protocol";
import type { Client } from "./client.ts";
import {
  type NativeProject,
  projectColors,
  readNativeProject,
} from "./project-presentation.ts";
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
  changed: (project: NativeProject) => void,
  generation: () => number = () => 0,
): ProjectEditCapability {
  let schema: { generation: number; fields: ProjectEditField[] } | undefined;
  async function fields(signal?: AbortSignal) {
    const current = generation();
    if (schema?.generation === current) return schema.fields;
    const doc = await client.json<Parameters<typeof writableProjectFields>[0]>(
      "/doc",
      { signal },
    );
    const fields = writableProjectFields(doc);
    if (current === generation()) schema = { generation: current, fields };
    return fields;
  }
  function snapshot(
    project: NativeProject,
    directory: string,
    fields: ProjectEditField[],
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
      fields,
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
  return {
    async read(directory, signal) {
      const [project, writable] = await Promise.all([
        readNativeProject(client, directory, signal),
        fields(signal),
      ]);
      return snapshot(project, directory, writable);
    },
    async prepare(target, patch, signal) {
      const current = generation();
      const [identity, writable] = await Promise.all([
        client.json<{ id: string }>("/project/current", {
          query: { directory: target.directory },
          signal,
        }),
        fields(signal),
      ]);
      if (
        identity.id !== target.projectID ||
        Object.keys(patch).some((field) =>
          !writable.includes(field as ProjectEditField)
        )
      ) {
        throw new HarnessError(
          "project.target",
          "The project or its writable fields changed. Reopen project settings.",
        );
      }
      return async (operation) => {
        if (current !== generation()) {
          throw new OperationFailure(
            "unavailable",
            "native.unavailable",
            new Error("Native connection changed"),
          );
        }
        const project = await client.json<NativeProject>(
          `/project/${encodeURIComponent(target.projectID)}`,
          {
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
          },
        );
        const result = project?.id
          ? snapshot(project, target.directory, writable)
          : undefined;
        if (
          result?.projectID !== target.projectID ||
          Object.entries(patch).some(([field, value]) =>
            result.values[field as ProjectEditField] !== value
          )
        ) {
          throw new OperationFailure(
            "unknown",
            "project.readback",
            new Error("Native project PATCH result differs"),
          );
        }
        if (current === generation()) changed(project);
        return result;
      };
    },
  };
}
