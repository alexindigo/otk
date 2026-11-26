// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { projectHash, projectRoute } from "../project-navigation.ts";
import { folderName } from "../project-names.ts";
import { route } from "../session.ts";
import * as client from "@otk/client";
Deno.test("project-only routes preserve server and literal paths without colliding with session routes", () => {
  const project = {
    sidecarId: "remote agent",
    directory: "/home/me/Projects/a #b/",
  };
  const hash = projectHash(project);
  assertEquals(projectRoute(hash), project);
  assertEquals(route(hash), undefined);
  assertEquals(projectRoute("#/local/session"), undefined);
  assertEquals(projectRoute("#project/local/%"), undefined);
  assertEquals(folderName(project.directory), "a #b");
});

Deno.test("shell title preserves session, project and application join semantics", () => {
  assertEquals(
    client.shellTitle("Session", "project"),
    "Session — project — OTK",
  );
  assertEquals(
    client.shellTitle(undefined, "/"),
    "/ — OTK",
  );
  assertEquals(client.shellTitle("", undefined), "OTK");
});
