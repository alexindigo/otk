// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { test } from "../../support/resources.ts";
import { OtkDb } from "@otk/store";
import { RpcRegistry } from "../../../core/mod.ts";
import { registerProjectEdit } from "../../../core/features/project-edit.ts";
import { fixture } from "./support.ts";
import { stub } from "./rpc_test.ts";
import type { ProjectEditSnapshot } from "@otk/protocol";

test("WP9 core gates native project edits and rejects foreign targets and unsupported fields before effects", async () => {
  const db = new OtkDb(await fixture(), [], { busyms: 5000 });
  try {
    const absent = stub(), missing = new RpcRegistry(absent, db);
    registerProjectEdit(missing, absent);
    await assertRejects(() =>
      missing.dispatch("project.settings", { directory: "/fixture" })
    );
    const current: ProjectEditSnapshot = {
      projectID: "fixture",
      directory: "/fixture",
      fields: ["name"],
      values: { name: "Before", icon: "", color: "", startScript: "" },
      colors: [],
      hints: [],
    };
    let effects = 0;
    const harness = stub({
      projectEdit: {
        read: () => Promise.resolve(current),
        update(target, patch) {
          effects++;
          assertEquals(target.projectID, "fixture");
          Object.assign(current.values, patch);
          return Promise.resolve(current);
        },
      },
    });
    const rpc = new RpcRegistry(harness, db);
    registerProjectEdit(rpc, harness);
    for (
      const params of [
        { ...current, projectID: "foreign", patch: { name: "No" } },
        { ...current, patch: { color: "blue" } },
        { ...current, patch: {} },
      ]
    ) await assertRejects(() => rpc.dispatch("project.update", params));
    assertEquals(effects, 0);
    assertEquals(
      await rpc.dispatch("project.update", {
        projectID: "fixture",
        directory: "/fixture",
        patch: { name: "After" },
      }),
      null,
    );
    assertEquals(effects, 1);
    assertEquals(current.values.name, "After");
  } finally {
    db.close();
  }
});
