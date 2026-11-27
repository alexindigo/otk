// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { OperationFailure } from "@otk/protocol";
import { failureValue } from "../failure-features.ts";
import { createInlineRename } from "../inline-rename.ts";

const target = { id: "one", title: "Before" };
function fixture(options: {
  validate?(value: string): string | undefined;
  current?(): string;
  wait?: Promise<void>;
} = {}) {
  const calls: string[] = [];
  const owner = createInlineRename<typeof target>({
    ...options,
    same: (a, b) => a.id === b.id,
    rename: async (_, value) => {
      calls.push(value);
      await options.wait;
    },
    failure: () => ({ kind: "error", text: "Failed" }),
  });
  owner.start(target);
  return { owner, calls };
}

Deno.test("inline validation keeps editing and does not send; editing clears feedback", async () => {
  const { owner, calls } = fixture({
    validate: (value) => value ? undefined : "Enter a name",
  });
  await owner.commit("  ");
  assertEquals(owner.state.invalid, "Enter a name");
  assertEquals(owner.state.editing, target);
  assertEquals(calls, []);
  owner.edit("New");
  assertEquals(owner.state.invalid, undefined);
  assertEquals(owner.state.input, "New");
});

Deno.test("inline empty without validation cancels", async () => {
  const { owner, calls } = fixture();
  await owner.commit(" ");
  assertEquals(owner.state.editing, undefined);
  assertEquals(calls, []);
});

Deno.test("inline rename blocks while pending and ignores a canceled response", async () => {
  const wait = Promise.withResolvers<void>();
  const { owner, calls } = fixture({ wait: wait.promise });
  const first = owner.commit("First");
  await owner.commit("Second");
  assertEquals(calls, ["First"]);
  owner.cancel();
  const secondTarget = { id: "two", title: "Other" };
  owner.start(secondTarget);
  wait.resolve();
  await first;
  assertEquals(owner.state.editing, secondTarget);
  assertEquals(owner.state.pendingTitle, undefined);
});

Deno.test("inline rename waits for the published value", async () => {
  let label = "Before";
  const { owner, calls } = fixture({ current: () => label });
  const request = owner.commit(" After ");
  assertEquals(owner.state.pendingTitle, "After");
  assertEquals(owner.editing, false);
  await request;
  assertEquals(calls, ["After"]);
  assertEquals(owner.state.pendingTitle, "After");
  owner.observe();
  assertEquals(owner.state.editing, target);
  label = "After";
  owner.observe();
  assertEquals(owner.state.editing, undefined);
  assertEquals(owner.state.pendingTitle, undefined);
});

for (const unknown of [false, true]) {
  Deno.test(`inline rename clears the submitted label on ${unknown ? "unknown" : "rejected"} outcome`, async () => {
    const wait = Promise.withResolvers<void>();
    const error = unknown
      ? new OperationFailure("unknown", "native.unknown", new Error())
      : new Error("Rejected");
    const feedback = failureValue(error, { action: "session.rename" });
    const owner = createInlineRename<typeof target>({
      same: (a, b) => a.id === b.id,
      current: () => "Before",
      rename: () => wait.promise,
      failure: () => feedback,
    });
    owner.start(target);
    const request = owner.commit("After");
    assertEquals(owner.state.pendingTitle, "After");
    wait.reject(error);
    await request;
    assertEquals(owner.state.pendingTitle, undefined);
    assertEquals(owner.editing, false);
    assertEquals(owner.state.error, feedback);
  });
}

Deno.test("blur cannot silently retry a rejected rename; Enter or a fresh edit can", async () => {
  const calls: string[] = [];
  const owner = createInlineRename<typeof target>({
    same: (a, b) => a.id === b.id,
    rename: (_, name) => {
      calls.push(name);
      return Promise.reject(new Error("Rejected"));
    },
    failure: () => ({ kind: "error", text: "Failed" }),
  });
  owner.start(target);
  await owner.commit("After");
  await owner.commit("After", "blur");
  assertEquals(calls, ["After"]);
  assertEquals(owner.state.error && owner.state.error.text, "Failed");
  assertEquals(owner.state.editing, target);

  await owner.commit("After");
  assertEquals(calls, ["After", "After"]);
  owner.edit("Different");
  await owner.commit("Different", "blur");
  assertEquals(calls, ["After", "After", "Different"]);
});
