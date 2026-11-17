// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { SessionSupervision } from "../../core/index/supervision.ts";
import { FormsFeature } from "../../core/features/forms.ts";
import { pendingInventoryFixture } from "../support/pending-inventory.ts";
import { tempDir, test } from "../support/resources.ts";

for (const kind of ["permission", "form"] as const) {
  test(`V2 failed ${kind} inventory is visible while its healthy sibling converges`, async () => {
    const f = await pendingInventoryFixture(
      await tempDir("pending-inventory-"),
    );
    await f.start();
    const owner = new SessionSupervision(), id = "opcv2-ses_" + kind;
    const sibling = "opcv2-ses_" + (kind === "form" ? "permission" : "form");
    assertEquals(owner.session(f.index.getMetadata(id)!, 0).state, "needsYou");
    f.control.failure = kind;
    f.control.empty.add(kind === "form" ? "permission" : "form");
    await f.reconnect();
    assertEquals(
      f.errors.some((value) => value.code === `inventory.${kind}`),
      true,
      "Failed inventory must reach the background-error consumer",
    );
    const row = f.index.getMetadata(id)!;
    assertEquals(
      kind === "form" ? row.attention.questions : row.attention.permissions,
      1,
    );
    assertEquals(
      owner.session(row, 0).state,
      "none",
      "Stale request evidence cannot drive needs-you",
    );
    assertEquals(
      owner.session(f.index.getMetadata(sibling)!, 0).state,
      "none",
      "Healthy sibling owns its absence independently",
    );
    const retained = kind === "form"
      ? await f.adapter.pending.forms.list({ sessionID: id })
      : await f.adapter.pending.permissions.listPermissions(id);
    assertEquals(retained.map((r) => r.id), [
      kind === "form" ? "frm_main" : "per_main",
    ]);
    f.control.failure = "";
    await f.reconnect();
    assertEquals(
      owner.session(f.index.getMetadata(id)!, 0).state,
      "needsYou",
      "Fresh nonempty reconnect inventory restores pending attention",
    );
    f.control.empty.add(kind);
    await f.reconnect();
    assertEquals(
      owner.session(f.index.getMetadata(id)!, 0).state,
      "none",
      "Fresh empty inventory retires request authority",
    );
  });
}

test("V2 stale location form payload cannot drive project attention and fresh seeding restores it", async () => {
  const f = await pendingInventoryFixture(
    await tempDir("pending-global-freshness-"),
  );
  await f.start();
  const forms = new FormsFeature(f.adapter.pending.forms, () => {});
  try {
    await forms.snapshot();
    assertEquals(forms.locations(), { [f.directory]: 1 });
    f.control.failure = "form";
    await f.reconnect();
    await forms.snapshot();
    assertEquals(
      forms.locations(),
      {},
      "Stale global request is not needs-you evidence",
    );
    assertEquals(
      (await f.adapter.pending.forms.list()).map((r) => r.id).sort(),
      ["frm_global", "frm_main"],
    );
    f.control.failure = "";
    await f.reconnect();
    await forms.snapshot();
    assertEquals(forms.locations(), { [f.directory]: 1 });
  } finally {
    forms.close();
  }
});

for (const kind of ["permission", "form"] as const) {
  test(`V2 failed ${kind} inventory cannot project stale pending keys`, async () => {
    const f = await pendingInventoryFixture(
      await tempDir("pending-freshness-"),
    );
    await f.start();
    f.control.failure = kind;
    await f.reconnect();
    const row = f.index.getMetadata("opcv2-ses_" + kind)!;
    const evidence = kind === "form"
      ? row.activity?.inputs
      : row.activity?.permissions;
    assertEquals(
      evidence?.keys,
      [],
      "Old pending identities are not fresh attention evidence",
    );
    assertEquals(
      row.attention.error,
      undefined,
      "Inventory failure is not a session error",
    );
  });
}

test("V2 dropped location retires counts, capability payload and global forms without inventing settlement", async () => {
  const f = await pendingInventoryFixture(await tempDir("pending-locations-"));
  await f.start();
  const owner = new SessionSupervision(), id = "opcv2-ses_dropped";
  assertEquals(owner.session(f.index.getMetadata(id)!, 0).state, "needsYou");
  f.control.locations = [];
  await f.reconnect();
  assertEquals(f.index.getMetadata(id)?.attention.permissions, 0);
  assertEquals(owner.session(f.index.getMetadata(id)!, 0).state, "none");
  assertEquals(await f.adapter.pending.permissions.listPermissions(id), []);
  assertEquals(await f.adapter.pending.forms.list(), []);
  assertEquals(
    f.adapter.pending.settled("permission", "per_drop"),
    false,
    "Scope disappearance is not request settlement",
  );
  f.control.locations = [f.directory, f.dropped];
  await f.reconnect();
  assertEquals(owner.session(f.index.getMetadata(id)!, 0).state, "needsYou");
  assertEquals((await f.adapter.pending.forms.list()).map((r) => r.id).sort(), [
    "frm_global",
    "frm_main",
  ]);
});

test("V2 explicit settlement wins over failed and later replayed inventory", async () => {
  const f = await pendingInventoryFixture(await tempDir("pending-settlement-"));
  await f.start();
  f.control.failure = "form";
  await f.reconnect();
  await f.settle("form", "frm_main", "ses_form");
  const owner = new SessionSupervision(), id = "opcv2-ses_form";
  assertEquals(owner.session(f.index.getMetadata(id)!, 0).state, "none");
  f.control.failure = "";
  await f.reconnect();
  assertEquals(owner.session(f.index.getMetadata(id)!, 0).state, "none");
  assertEquals(await f.adapter.pending.forms.list({ sessionID: id }), []);
});

test("V2 pending projection changes even when session metadata cannot refresh", async () => {
  const f = await pendingInventoryFixture(await tempDir("pending-metadata-"));
  await f.start();
  const owner = new SessionSupervision(), id = "opcv2-ses_form";
  f.control.failure = "form";
  f.control.metadataFailure = true;
  await f.reconnect();
  assertEquals(owner.session(f.index.getMetadata(id)!, 0).state, "none");
  assertEquals((await f.adapter.pending.forms.list()).map((r) => r.id).sort(), [
    "frm_global",
    "frm_main",
  ]);
  f.control.locations = [];
  await f.reconnect();
  assertEquals(owner.session(f.index.getMetadata(id)!, 0).state, "none");
  assertEquals(f.index.getMetadata(id)?.attention.questions, 0);
  assertEquals(await f.adapter.pending.forms.list(), []);
});
