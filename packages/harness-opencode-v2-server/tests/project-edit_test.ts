// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { projectEditor } from "../project-edit.ts";
import type { V2Client } from "../client.ts";
import { OperationFailure } from "@otk/protocol";

Deno.test("V2 verifies persisted PATCH fields and invalidates only confirmed effects", async () => {
  let project = {
    id: "repo",
    canonical: "/repo",
    name: "Before",
    icon: { override: "", color: "" },
    commands: { start: "" },
  };
  const calls: string[] = [];
  const api = {
    location: { get: () => Promise.resolve({ project: { id: "repo" } }) },
    project: {
      list: () => {
        calls.push("read");
        return Promise.resolve([project]);
      },
      update: (input: typeof project & { projectID: string }) => {
        calls.push(`write:${input.projectID}`);
        project = {
          ...project,
          ...input,
          icon: { ...project.icon, ...input.icon },
          commands: { ...project.commands, ...input.commands },
        };
        return Promise.resolve(project);
      },
    },
  };
  const client = {
    read: (read: (api: unknown) => Promise<unknown>) => read(api),
    effect: (effect: (api: unknown) => Promise<unknown>) => effect(api),
  } as unknown as V2Client;
  let invalidated = 0;
  const editor = projectEditor(() => client, () => invalidated++);
  const snapshot = await editor.read("/repo/sub");
  assertEquals(snapshot.projectID, "repo");
  for (
    const [field, value] of Object.entries({
      name: "After",
      icon: "data:image/png;base64,AA==",
      color: "blue",
      startScript: "echo start",
    })
  ) {
    calls.length = 0;
    const result = await (await editor.prepare(snapshot, { [field]: value }))();
    assertEquals(result.values[field as keyof typeof result.values], value);
    assertEquals(calls, ["write:repo"]);
  }
  assertEquals(invalidated, 4);
  await assertRejects(() =>
    editor.prepare({ ...snapshot, projectID: "foreign" }, { name: "No" })
  );
});

Deno.test("V2 mismatching persisted PATCH result stays uncertain and is not published as confirmed", async () => {
  let written = false, changes = 0;
  const api = {
    location: { get: () => Promise.resolve({ project: { id: "fixture" } }) },
    project: {
      update: () => {
        written = true;
        return Promise.resolve({ id: "fixture", name: "Before" });
      },
      list: () =>
        Promise.reject(
          new OperationFailure(
            "unavailable",
            "native.unavailable",
            new Error("read lost"),
          ),
        ),
    },
  };
  const client = {
    read: (read: (api: unknown) => Promise<unknown>) => read(api),
    effect: (effect: (api: unknown) => Promise<unknown>) => effect(api),
  } as unknown as V2Client;
  const error = await assertRejects(
    async () =>
      (await projectEditor(() => client, () => changes++).prepare({
        directory: "/fixture",
        projectID: "fixture",
      }, { name: "After" }))(),
    OperationFailure,
  );
  assertEquals(written, true);
  assertEquals(error.outcome, "unknown");
  assertEquals(changes, 0);
});
