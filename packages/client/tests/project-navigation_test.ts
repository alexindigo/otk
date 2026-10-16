// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  projectHash,
  projectName,
  projectRoute,
} from "../project-navigation.ts";
import { route } from "../session.ts";
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
  assertEquals(projectName(project.directory), "a #b");
});
