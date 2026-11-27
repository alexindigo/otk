// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { UNKNOWN_REPOSITORY } from "@otk/protocol";
import { ImageRoots } from "../../../core/files/image-roots.ts";

Deno.test("allowed image templates derive their project and checkouts from authority", () => {
  const canonicalRoot = "/p/otk";
  const topologies = ["/p/otk.ride", "/p/otk.x", "/p/otk.old"].map(
    (leafDirectory) => ({ repoID: "otk", canonicalRoot, leafDirectory }),
  );
  topologies.push({
    repoID: "unknown",
    leafDirectory: "/p/no-git",
    canonicalRoot: UNKNOWN_REPOSITORY,
  });
  const identity = {
    topology: (directory: string) =>
      topologies.find((t) => t.leafDirectory === directory),
    topologies: () => topologies,
    availability: (directory: string) =>
      directory === "/p/otk.old" ? "removed" as const : "present" as const,
  };
  const templates = [
    "{checkouts}",
    "~/Documents/{project}",
    "~/TemporaryFiles/{project}",
  ];
  const roots = new ImageRoots({ templates, identity, home: "/home/fixture" });
  assertEquals(roots.roots("/p/otk.ride"), [
    "/p/otk.ride",
    "/p/otk",
    "/p/otk.x",
    "/home/fixture/Documents/otk",
    "/home/fixture/TemporaryFiles/otk",
  ]);
  for (const project of ["luch", "no-git"]) {
    assertEquals(roots.roots(`/p/${project}`), [
      `/p/${project}`,
      `/home/fixture/Documents/${project}`,
      `/home/fixture/TemporaryFiles/${project}`,
    ]);
  }
  assertEquals(roots.roots("/p/.hidden"), ["/p/.hidden"]);
  assertEquals(
    new ImageRoots({ templates, identity, home: "relative" }).roots("/p/luch"),
    ["/p/luch"],
  );
  assertEquals(
    new ImageRoots({ templates: [], identity, home: "/home/fixture" }).roots(
      "/p/luch",
    ),
    [],
  );
});
