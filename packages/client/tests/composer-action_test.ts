// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import * as primary from "../primary-action.ts";
import { createSessionDelivery } from "../session-delivery.ts";

const ready = {
  active: true,
  suspended: false,
  connected: true,
  supported: true,
  stopSupported: true,
  content: true,
  chips: [],
  unstarted: 0,
  running: false,
  sending: false,
};

for (
  const [name, facts, buttonKind, enterKind, reason] of [
    ["idle draft", {}, "send", "send", undefined],
    ["running", { running: true }, "send", "send", undefined],
    ["queued", { unstarted: 1 }, "send", "send", undefined],
    ["chips only", { chips: [{}] }, "send", "send", undefined],
    ["blank", { content: false }, "none", "none", "Write a message"],
    [
      "blank during run",
      { content: false, running: true },
      "stop",
      "none",
      undefined,
    ],
    [
      "blank while waiting",
      { content: false, unstarted: 1 },
      "stop",
      "none",
      undefined,
    ],
    [
      "blank while stopping",
      { content: false, stopping: true },
      "stop",
      "none",
      "Stopping",
    ],
    ["new draft after Stop", { stopping: true }, "send", "send", undefined],
    [
      "previous Send",
      { sending: true },
      "send",
      "send",
      "Previous message still sending",
    ],
    [
      "disconnected",
      { connected: false },
      "send",
      "send",
      "Reconnecting - message kept",
    ],
    [
      "takeover",
      { suspended: true },
      "send",
      "send",
      "Answer the pending request first",
    ],
    [
      "inactive",
      { active: false },
      "send",
      "send",
      "Composer is no longer active",
    ],
    [
      "unsupported",
      { supported: false },
      "send",
      "send",
      "Sending is not supported here",
    ],
    [
      "reading chips",
      { chips: [{ pending: true }] },
      "send",
      "send",
      "Waiting for attachment",
    ],
    [
      "failed chip",
      { chips: [{ error: true }] },
      "send",
      "send",
      "Remove or retry the failed attachment",
    ],
  ] as const
) {
  Deno.test(`composer action: ${name}`, () => {
    const action = (source: "button" | "enter") =>
      primary.composerAction({ ...ready, ...facts }, source);
    assertEquals(action("button").kind, buttonKind);
    assertEquals(action("button").available, reason === undefined);
    assertEquals(action("button").reason, reason);
    assertEquals(action("enter").kind, enterKind);
    if (buttonKind === "stop") {
      assertEquals(action("enter").available, false);
      assertEquals(action("enter").reason, "Type a message to send");
    } else {
      assertEquals(action("enter"), action("button"));
    }
  });
}

for (const source of ["enter", "button"] as const) {
  for (
    const [name, change, reason] of [
      ["disconnect", { connected: false }, "Reconnecting - message kept"],
      ["switch", { active: false }, "Composer is no longer active"],
      ["takeover", { suspended: true }, "Answer the pending request first"],
      ["empty", { content: false, running: true }, "Type a message to send"],
    ] as const
  ) {
    Deno.test(`${source} revalidates after preparation: ${name}`, async () => {
      const prepare = Promise.withResolvers<void>();
      let facts = { ...ready };
      const effects: string[] = [];
      const owner = primary.createComposerAction({
        facts: () => facts,
        draft: () => "retained draft",
        prepare: () => prepare.promise,
        send: () => {
          effects.push("send");
          return Promise.resolve();
        },
        stop: () => {
          effects.push("stop");
          return Promise.resolve();
        },
        refuse: (reason, origin, recheckAs) =>
          effects.push(`${origin}/${recheckAs}: ${reason}`),
        begin: () => {},
      });
      const attempt = owner.activate(source);
      assertEquals(owner.state.sending, true);
      facts = { ...facts, ...change };
      prepare.resolve();
      await attempt;
      assertEquals(effects, [`${source}/enter: ${reason}`]);
      assertEquals(owner.state.sending, false);
    });
  }

  Deno.test(`${source} sends once, rejects a second draft, and preserves explicit local commands`, async () => {
    const ack = Promise.withResolvers<void>();
    const called = Promise.withResolvers<void>();
    const notices: string[] = [], payloads: string[] = [];
    let commands = 0, stops = 0;
    let draft = "first message";
    const delivery = createSessionDelivery({
      target: { sidecarId: "local", sessionID: "opcv2-ses_send" },
      title: () => "Captured session",
      transcript: () => undefined,
      clock: { set: () => 0, clear: () => {} },
    });
    const owner = primary.createComposerAction({
      facts: (draft) => ({ ...ready, content: !!draft, running: true }),
      draft: () => draft,
      local: (draft) =>
        draft === "/local"
          ? () => {
            commands++;
            return Promise.resolve();
          }
          : undefined,
      prepare: () => Promise.resolve(),
      send: async (captured) => {
        payloads.push(captured);
        void delivery.send(async (dispatch) => {
          dispatch();
          called.resolve();
          await ack.promise;
          return { messageID: "native-user-id", state: "queued" };
        });
        await ack.promise;
      },
      stop: () => {
        stops++;
        return Promise.resolve();
      },
      refuse: (reason) => notices.push(reason),
      begin: () => {},
    });
    try {
      const first = owner.activate(source);
      await called.promise;
      draft = "second message";
      await owner.activate(source);
      assertEquals(notices, ["Previous message still sending"]);
      assertEquals(draft, "second message");
      draft = "/local";
      await owner.activate(source);
      assertEquals(commands, 1);
      assertEquals(owner.state.sending, true);
      assertEquals(payloads, ["first message"]);
      draft = "";
      assertEquals(owner.state.mode, "stop");
      await owner.activate("enter");
      assertEquals(stops, 0);
      await owner.activate("button");
      assertEquals(stops, 1);
      ack.resolve();
      await first;
      assertEquals(
        delivery.state.receipts.some((r) => r.phase === "queued"),
        true,
      );
      draft = "second message";
      assertEquals(owner.state.available, true);
      assertEquals(owner.state.reason, undefined);
      assertEquals(payloads, ["first message"]);
    } finally {
      delivery.stop();
    }
  });
}
