// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Harness } from "@otk/harness";
import type { FormAnswer, FormRequest, FormsCapability } from "@otk/protocol";
import { OtkDb } from "@otk/store";
import { FormsFeature, register } from "../../../core/features/forms.ts";
import { RpcRegistry } from "../../../core/ws/registry.ts";
import { ProjectSummaries } from "../../../core/index/project-summaries.ts";
import { test } from "../../support/resources.ts";
import { fixture } from "./support.ts";
const request: FormRequest = {
  id: "form",
  owner: { kind: "location", directory: "/repo" },
  directory: "/repo",
  title: "Project form",
  fields: [{ key: "ready", type: "boolean", required: true }],
};
test("typed form RPC preserves numbers/false/arrays, rejects coercions and keeps answers out of receipts", async () => {
  const calls: unknown[] = [];
  const capability: FormsCapability = {
    list: () => Promise.resolve([request]),
    watch: () => () => {},
    reply: (id, answer) => {
      calls.push([id, answer]);
      return Promise.resolve();
    },
    cancel: (id, message) => {
      calls.push([id, message]);
      return Promise.resolve();
    },
  };
  const db = new OtkDb(await fixture(), [], { busyms: 5000 });
  const harness = {
    core: {},
    capabilities: { forms: capability },
  } as unknown as Harness;
  const rpc = new RpcRegistry(harness, db);
  register(rpc, harness);
  const answer = {
    count: 2,
    rate: .25,
    ready: false,
    values: ["value"],
    name: "literal",
  };
  await rpc.dispatch("form.reply", { requestID: "form", answer });
  assertEquals(JSON.parse(JSON.stringify(calls[0])), ["form", answer]);
  await rpc.dispatch("form.cancel", { requestID: "form" });
  await rpc.dispatch("form.cancel", {
    requestID: "form",
    message: "Continue with another approach.",
  });
  assertEquals(calls.slice(1), [["form", undefined], [
    "form",
    "Continue with another approach.",
  ]]);
  for (
    const invalid of [null, [], { number: NaN }, { nested: {} }, {
      array: [false],
    }]
  ) {
    await assertRejects(() =>
      rpc.dispatch("form.reply", { requestID: "form", answer: invalid })
    );
  }
  const receipt = rpc.policy("form.reply")!.receipt!(null);
  assertEquals(receipt, { kind: "form-replied", value: { completed: true } });
  assertThrows(() =>
    rpc.policy("form.reply")!.checkpoint!({
      kind: "form-replied",
      value: { answer } as unknown as { completed: true },
    })
  );
  db.close();
});
test("location form attention is scalar, survives no session membership, and retires without fabricated sessions", async () => {
  let requests = [request], notify = () => {}, closed = false;
  const capability: FormsCapability = {
    list: () => Promise.resolve(requests),
    reply: (_id: string, _answer: FormAnswer) => Promise.resolve(),
    cancel: () => Promise.resolve(),
    watch: (listener) => {
      notify = listener;
      return () => {
        closed = true;
      };
    },
  };
  const feature = new FormsFeature(capability, (error) => {
    throw error;
  });
  const summaries = new ProjectSummaries(
    () => ({ seen: 0, finish: 0 }),
    () => {},
  );
  const stop = feature.listen(() =>
    summaries.locationForms(feature.locations())
  );
  await feature.snapshot();
  summaries.retain([]);
  assertEquals(feature.locations(), { "/repo": 1 });
  const summary = summaries.values.get("/repo")!;
  assertEquals([summary.status, summary.hasSessions, summary.locationForms], [
    "blocked",
    false,
    1,
  ]);
  assertEquals(summary.sessionCount, null);
  requests = [];
  notify();
  await feature.snapshot();
  assertEquals(feature.locations(), {});
  assertEquals(summaries.values.get("/repo")?.locationForms, undefined);
  stop();
  feature.close();
  assertEquals(closed, true);
});
