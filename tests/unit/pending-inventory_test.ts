// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { SessionSupervision } from "../../core/index/supervision.ts";
import { FormsFeature } from "../../core/features/forms.ts";
import { pendingInventoryFixture } from "../support/pending-inventory.ts";
import { tempDir, test } from "../support/resources.ts";

test("V2 pending inventory fixture serves empty transcript and native inbox", async () => {
  const f = await pendingInventoryFixture(await tempDir("pending-inbox-"));
  await f.start();
  for (const session of f.sessions) {
    const id = "opcv2-" + session.id;
    const page = await f.adapter.core.listMessages(id, {});
    assertEquals(page.sessionID, id);
    assertEquals(page.items, []);
    assertEquals(f.reads.includes(`/api/session/${session.id}/inbox`), true);
  }
});

for (const status of [404, 405, 501]) {
  test(`V2 unsupported inbox (${status}) preserves the transcript and one session notice without repeated reads`, async () => {
    const f = await pendingInventoryFixture(
      await tempDir("unsupported-inbox-"),
    );
    f.control.inboxStatus = status;
    await f.start();
    const id = "opcv2-ses_form";
    const [first, sibling] = await Promise.all([
      f.adapter.core.listMessages(id, {}),
      f.adapter.core.listMessages("opcv2-ses_permission", {}),
    ]);
    assertEquals(sibling.session.notices?.length, 1);
    assertEquals(first.items.map((m) => m.id), ["msg_transcript"]);
    assertEquals(first.session.notices?.length, 1);
    const notice = first.session.notices![0];
    assertEquals(notice.facts?.actionLabel, "Loading queued messages");
    assertEquals(notice.facts?.target?.sessionID, id);
    assertEquals(
      notice.facts?.reason,
      "Queued messages aren't available on this server.",
    );
    assertEquals(notice.facts?.recovery, undefined);
    for (const session of [id, id, "opcv2-ses_permission"]) {
      const page = await f.adapter.core.listMessages(session, {});
      assertEquals(page.items.map((m) => m.id), ["msg_transcript"]);
      assertEquals(page.session.notices?.length, 1);
      assertEquals(page.session.notices![0].diagnosticID, notice.diagnosticID);
      assertEquals(page.session.notices![0].facts?.target?.sessionID, session);
    }
    assertEquals(f.reads.filter((path) => path.endsWith("/inbox")).length, 1);
  });
}

test("V2 older transcript pages retain the first page's unsupported queue notice", async () => {
  const f = await pendingInventoryFixture(await tempDir("older-inbox-notice-"));
  f.control.inboxStatus = 404;
  f.control.transcriptRows = 15;
  await f.start();
  const first = await f.adapter.core.listMessages("opcv2-ses_form", {});
  assertEquals(typeof first.older, "string");
  assertEquals(first.session.notices?.map((notice) => notice.code), [
    "queued-messages.unsupported",
  ]);
  const older = await f.adapter.core.listMessages("opcv2-ses_form", {
    before: first.older!,
  });
  assertEquals(older.items.length, 5);
  assertEquals(older.session.notices, first.session.notices);
  assertEquals(f.reads.filter((path) => path.endsWith("/inbox")).length, 1);
});

test("V2 retained queue notices use the current session title on older pages", async () => {
  const f = await pendingInventoryFixture(
    await tempDir("renamed-inbox-notice-"),
  );
  f.control.inboxStatus = 404;
  f.control.transcriptRows = 15;
  const session = f.sessions.find((row) => row.id === "ses_form")!;
  session.title = "Draft";
  await f.start();
  const first = await f.adapter.core.listMessages("opcv2-ses_form", {});
  assertEquals(typeof first.older, "string");
  assertEquals(first.session.notices?.length, 1);
  assertEquals(first.session.notices![0].facts?.target?.label, "Draft");
  f.adapter.transcript.observe({
    ...session,
    title: "Final",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  const older = await f.adapter.core.listMessages("opcv2-ses_form", {
    before: first.older!,
  });
  assertEquals(older.items.length, 5);
  assertEquals(older.session.title, "Final");
  assertEquals(older.session.notices?.length, 1);
  assertEquals(older.session.notices![0].facts?.target?.label, "Final");
  assertEquals(
    older.session.notices![0].diagnosticID,
    first.session.notices![0].diagnosticID,
  );
  assertEquals(first.session.notices![0].facts?.target?.label, "Draft");
  assertEquals(f.reads.filter((path) => path.endsWith("/inbox")).length, 1);
});

test("V2 unavailable inbox is not misreported as an unsupported capability", async () => {
  const f = await pendingInventoryFixture(await tempDir("unavailable-inbox-"));
  f.control.inboxStatus = 503;
  await f.start();
  await assertRejects(() => f.adapter.core.listMessages("opcv2-ses_form", {}));
  f.control.inboxStatus = 200;
  assertEquals(
    (await f.adapter.core.listMessages("opcv2-ses_form", {})).session.notices,
    undefined,
  );
});

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
