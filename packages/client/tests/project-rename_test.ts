// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertObjectMatch } from "@std/assert";
import { createProjectRename } from "../project-rename.ts";

const project = {
  directory: "/fixture",
  sidecarId: "one",
  projectID: "native-1",
  title: "Fixture",
};

Deno.test("project rename validates, trims, and sends reset as the empty native name", async () => {
  const updates: unknown[] = [];
  let label = project.title;
  const owner = createProjectRename({
    update(target, name) {
      updates.push({ ...target, name });
      label = name || project.title;
      return Promise.resolve();
    },
    label: () => label,
  });
  owner.start(project);
  await owner.commit("  Fixture ");
  assertEquals(owner.state.editing, undefined);
  owner.start(project);
  await owner.commit("  ");
  assertEquals(
    owner.state.invalid,
    "Enter a name. Reset name in the row menu restores the folder name.",
  );
  assertEquals(owner.state.editing, project);
  assertEquals(updates, []);
  await owner.commit("  Fixture app  ");
  assertEquals(owner.state.editing, undefined);
  await owner.reset(project);
  assertEquals(updates, [
    { ...project, name: "Fixture app" },
    { ...project, name: "" },
  ]);
});

Deno.test("a rejected project rename keeps the typed name and context for retry", async () => {
  let label = project.title;
  const owner = createProjectRename({
    update(_, name) {
      if (name === "Denied") {
        return Promise.reject(new Error("Native rejected the name"));
      }
      label = name;
      return Promise.resolve();
    },
    label: () => label,
  });
  owner.start(project);
  await owner.commit("Denied");
  assertEquals(owner.state.editing, project);
  assertEquals(owner.state.input, "Denied");
  assertObjectMatch(owner.state.error || {}, {
    kind: "error",
    failure: { action: "Renaming project", target: { label: "Fixture" } },
  });
  await owner.commit("Retried");
  assertEquals(label, "Retried");
  assertEquals(owner.state.error, undefined);
  assertEquals(owner.state.editing, undefined);
});

Deno.test("an admitted project rename retains the edit until native confirmation and publication", async () => {
  const write = Promise.withResolvers<void>();
  let label = project.title;
  const owner = createProjectRename({
    update: () => write.promise,
    label: () => label,
  });
  owner.start(project);
  const saving = owner.commit("After");
  owner.cancel();
  owner.start({ ...project, directory: "/another" });
  label = "After";
  owner.observe();
  assertEquals(owner.state.editing, project);
  assertEquals(owner.state.pendingTitle, "After");
  write.resolve();
  await saving;
  assertEquals(owner.state.editing, undefined);
  assertEquals(owner.state.pendingTitle, undefined);
});
