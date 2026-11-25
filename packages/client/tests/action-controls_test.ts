// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { CommandHub } from "../commands.ts";

Deno.test("action control rechecks availability and presents every non-shown outcome", async () => {
  const hub = new CommandHub();
  let allowed = true, shown = false, calls = 0;
  hub.register({
    id: "fixture",
    title: "Open fixture",
    category: "Test",
    availability: () =>
      allowed
        ? { available: true }
        : { available: false, reason: "Already open" },
    run() {
      calls++;
      shown = true;
    },
  });
  const action = hub.control("fixture", undefined, {
    target: { label: "Fixture session" },
    shown: () => shown,
    unshown: "The fixture did not open",
    recovery: "Choose another session",
  });
  assertEquals(action.availability(), { available: true });
  allowed = false;
  const refused = await action.run();
  assertEquals(refused.kind, "refused");
  assert(
    refused.kind !== "shown" && refused.feedback.text.includes("Already open"),
  );
  assert(refused.feedback.failure?.action.includes("Open fixture"));
  assertEquals(calls, 0);
  allowed = true;
  assertEquals((await action.run()).kind, "shown");
  assertEquals(calls, 1);
});

Deno.test("action control refuses unobserved and false outcomes, catches sync and async failures", async () => {
  for (const mode of ["nothing", "false", "throw", "reject"] as const) {
    const hub = new CommandHub();
    hub.register({
      id: "fixture",
      title: "Opening fixture",
      category: "Test",
      availability: () => ({ available: true }),
      run: () => {
        if (mode === "throw") throw new Error("private diagnostic");
        if (mode === "reject") {
          return Promise.reject(new Error("private diagnostic"));
        }
        return mode === "false" ? false : undefined;
      },
    });
    const result = await hub.control("fixture", undefined, {
      target: { label: "Target" },
      shown: () => mode === "false",
      unshown: "The fixture did not open",
      recovery: "Open Sessions and choose the target",
    }).run();
    assertEquals(
      result.kind,
      mode === "throw" || mode === "reject" ? "failed" : "refused",
    );
    assert(result.kind !== "shown" && result.feedback.text.length > 0);
    assert(!result.feedback.text.includes("private diagnostic"));
    assert(
      result.feedback.failure?.recovery ===
        "Open Sessions and choose the target",
    );
  }
});

Deno.test("action controls cannot become silent when their command owner retires", async () => {
  const hub = new CommandHub();
  const release = hub.register({
    id: "fixture",
    title: "Open target",
    category: "Test",
    run() {},
  });
  const action = hub.control("fixture", undefined, {
    target: { label: "Target" },
    shown: () => true,
    unshown: "The fixture did not open",
    recovery: "Reopen Sessions",
  });
  release();
  const result = await action.run();
  assertEquals(result.kind, "refused");
  assert(result.kind !== "shown" && result.feedback.text.includes("inactive"));
});

Deno.test("action outcomes retain their invoking owner after registration replacement", async () => {
  const hub = new CommandHub();
  let reject!: (cause: unknown) => void;
  const release = hub.register({
    id: "fixture",
    title: "Open original",
    category: "Test",
    availability: () => ({ available: true }),
    run: () => new Promise((_resolve, fail) => reject = fail),
  });
  const action = hub.control("fixture", undefined, {
    target: { label: "Original target" },
    shown: () => false,
    unshown: "No view opened",
    recovery: "Choose the target again",
  });
  const pending = action.run();
  assertEquals(action.run(), pending);
  await Promise.resolve();
  release();
  hub.register({
    id: "fixture",
    title: "Open replacement",
    category: "Test",
    run() {},
  });
  reject(new Error("private original diagnostic"));
  const outcome = await pending;
  assertEquals(outcome.kind, "failed");
  assert(outcome.kind !== "shown");
  assert(outcome.feedback.failure?.action.includes("Open original"));
  assert(!outcome.feedback.text.includes("replacement"));
});

Deno.test("retired presentation controls refuse before invoking their command", async () => {
  const hub = new CommandHub();
  let active = true, calls = 0;
  hub.register({
    id: "fixture",
    title: "Open original",
    category: "Test",
    run: () => calls++,
  });
  const action = hub.control("fixture", undefined, {
    target: { label: "Target" },
    active: () => active,
    shown: () => true,
    unshown: "No view opened",
    recovery: "Reopen the notification",
  });
  active = false;
  assertEquals(action.availability().available, false);
  assertEquals((await action.run()).kind, "refused");
  assertEquals(calls, 0);
});

Deno.test("action controls publish registration changes without retaining retired views", () => {
  const hub = new CommandHub();
  const action = hub.control("fixture", undefined, {
    target: { label: "Target" },
    shown: () => true,
    unshown: "No result",
    recovery: "Reopen the view",
  });
  let changes = 0;
  const stop = action.subscribe(() => changes++);
  const release = hub.register({
    id: "fixture",
    title: "Open",
    category: "Test",
    run() {},
  });
  assertEquals(changes, 1);
  assertEquals(action.availability().available, true);
  release();
  assertEquals(changes, 2);
  stop();
  hub.register({ id: "fixture", title: "Open", category: "Test", run() {} });
  assertEquals(changes, 2);
});
