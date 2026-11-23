// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { type CommandContext, CommandHub } from "@otk/client";
import { sessionOpenControl } from "../components/session-open.ts";
import {
  registerSessionCommands,
  registerSessionTargetCommands,
} from "../shell/commands/sessions.ts";

const commands = (
  context: () => CommandContext = () => ({
    sidecar: "one",
    session: "current",
  }),
) => {
  const hub = new CommandHub(context);
  registerSessionCommands(hub, {
    available: () => true,
    create: () => Promise.resolve(),
    open() {},
    child: () => true,
    older: () => Promise.resolve(),
    retry: () => Promise.resolve(),
  });
  return hub;
};

Deno.test("an Open offer for the session on screen is not offered", () => {
  const hub = commands();
  assertEquals(hub.availability("session.child", undefined, "current"), {
    available: false,
    reason: "Already open",
    hidden: true,
  });
  assertEquals(hub.availability("session.child", undefined, "other"), {
    available: true,
  });
});

Deno.test("a selected session behind another view is not an already-open offer", () => {
  let viewing = false;
  const hub = commands(() => ({ sidecar: "one", session: "current", viewing }));
  assertEquals(hub.availability("session.child", undefined, "current"), {
    available: true,
  });
  viewing = true;
  assertEquals(hub.availability("session.child", undefined, "current"), {
    available: false,
    reason: "Already open",
    hidden: true,
  });
});

Deno.test("Open observes the presented view, not only retained selection", async () => {
  let session = "current", viewing = false, reveal = false;
  const hub = new CommandHub(() => ({ sidecar: "one", session, viewing }));
  registerSessionCommands(hub, {
    available: () => true,
    create: () => Promise.resolve(),
    open() {},
    child: (id) => {
      session = id;
      if (reveal) viewing = true;
      return true;
    },
    older: () => Promise.resolve(),
    retry: () => Promise.resolve(),
  });
  const action = sessionOpenControl(hub, "other", "Other session");
  assertEquals((await action.run()).kind, "refused");
  reveal = true;
  assertEquals((await action.run()).kind, "shown");
});

Deno.test("routing to the current session stays an ordinary re-selection", () => {
  // Notification defaults, the project picker and rows route without offering.
  assertEquals(
    commands().availability("session.open", undefined, {
      sidecarId: "one",
      sessionID: "current",
    }),
    { available: true },
  );
});

Deno.test("session preview offers share self-target availability with entity cards", () => {
  let viewing = true;
  const hub = commands(() => ({ sidecar: "one", session: "current", viewing }));
  registerSessionTargetCommands(hub, {
    current: () => ({ sidecarId: "one", sessionID: "current" }),
    exists: () => true,
    connected: () => true,
    inTask: () => false,
    open: () => true,
    pin: () => Promise.resolve(true),
    close: () => Promise.resolve(true),
  });
  const current = {
    sidecarId: "one",
    sessionID: "current",
  };
  assertEquals(hub.availability("session.preview", undefined, current), {
    available: true,
  });
  assertEquals(
    hub.control("session.preview", current, {
      target: current,
      shown: () => true,
      unshown: "No view opened",
      recovery: "Choose another session",
    }).availability(),
    {
      available: false,
      reason: "Already open",
      hidden: true,
    },
  );
  assertEquals(
    hub.availability("session.preview", undefined, {
      sidecarId: "two",
      sessionID: "current",
    }),
    { available: true },
  );
  viewing = false;
  assertEquals(
    hub.control("session.preview", current, {
      target: current,
      shown: () => true,
      unshown: "No view opened",
      recovery: "Choose another session",
    }).availability(),
    { available: true },
  );
  assertEquals(
    hub.contextActions({ kind: "session", data: current }).some((action) =>
      action.title === "Open"
    ),
    true,
  );
});
