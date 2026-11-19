// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { projectEditor, writableProjectFields } from "../project-edit.ts";
import { Client } from "../client.ts";

Deno.test("WP9 V1 advertises only installed native schema fields", () => {
  assertEquals(writableProjectFields({}), []);
  assertEquals(
    writableProjectFields({
      paths: {
        "/project/{projectID}": {
          patch: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { properties: { name: {}, icon: {} } },
                },
              },
            },
          },
        },
      },
    }),
    ["name", "icon", "color"],
  );
});
Deno.test("WP9 V1 writes and rereads every supported field without crossing project identity", async () => {
  let current = {
    id: "fixture",
    name: "",
    icon: { override: "", color: "" },
    commands: { start: "" },
  };
  const calls: string[] = [];
  const cached = structuredClone(current);
  const client = new Client(
    {
      url: "http://fixture",
      requestms: 1000,
      username: "",
      password: "",
      db: "",
      heartbeattimeout: 1000,
      reconnectmax: 1000,
    },
    ((url, options) => {
      const path = new URL(String(url)).pathname;
      if (path === "/doc") {
        return Promise.resolve(Response.json({
          paths: {
            "/project/{projectID}": {
              patch: {
                requestBody: {
                  content: {
                    "application/json": {
                      schema: {
                        properties: { name: {}, icon: {}, commands: {} },
                      },
                    },
                  },
                },
              },
            },
          },
        }));
      }
      calls.push(`${options?.method ?? "GET"}:${path}`);
      if (path === "/project/current") {
        return Promise.resolve(Response.json(cached));
      }
      if (path === "/project") return Promise.resolve(Response.json([current]));
      if (options?.method === "PATCH") {
        const patch = JSON.parse(String(options.body));
        current = {
          ...current,
          ...patch,
          icon: { ...current.icon, ...patch.icon },
          commands: { ...current.commands, ...patch.commands },
        };
      }
      return Promise.resolve(Response.json(current));
    }) as typeof fetch,
  );
  let changes = 0;
  const editor = projectEditor(client, () => changes++),
    initial = await editor.read("/fixture");
  for (
    const [field, value] of Object.entries({
      name: "Fixture",
      icon: "data:image/png;base64,AA==",
      color: "blue",
      startScript: "echo fixture",
    })
  ) {
    calls.length = 0;
    const result = await editor.update(initial, { [field]: value });
    assertEquals(result.values[field as keyof typeof result.values], value);
    assertEquals(calls, [
      "GET:/project/current",
      "GET:/project",
      "PATCH:/project/fixture",
      "GET:/project/current",
      "GET:/project",
    ]);
  }
  assertEquals(changes, 4);
  await assertRejects(() =>
    editor.update({ ...initial, projectID: "foreign" }, { name: "No" })
  );
});
