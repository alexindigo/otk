// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { entityKey, type EntityState } from "@otk/protocol";
import {
  attentionCount,
  awaitAcknowledged,
  createEntityStateStore,
  presentedEntity,
} from "../mod.ts";

Deno.test("clear feedback waits for published terminals without consuming a newer run", async () => {
  const key = entityKey("session", "s");
  const entries: Record<string, EntityState> = {
    [key]: {
      ...presentedEntity("session", "s", "finished", true),
      terminal: 30,
    },
  };
  const store = createEntityStateStore({ read: () => entries });
  const requested = { sessions: [{ sessionID: "s", terminal: 30 }] };
  const abort = new AbortController();
  let shown = false;
  const result = awaitAcknowledged(store, requested, abort.signal).then(() => {
    shown = true;
  });
  await Promise.resolve();
  assertEquals(shown, false);
  entries[key] = { ...entries[key], terminal: 31 };
  store.observe([key], "live");
  await result;
  assertEquals(shown, true);
  const stale = assertRejects(
    () =>
      awaitAcknowledged(store, {
        sessions: [{ sessionID: "s", terminal: 31 }],
      }, abort.signal),
    Error,
    "The lamps did not update",
  );
  store.stale(true);
  await stale;
  store.stop();
});

Deno.test("clear attention counts published unseen runs, not live inputs", () => {
  const key = entityKey("session", "s");
  const store = createEntityStateStore({
    read: () => ({
      [key]: {
        ...presentedEntity("session", "s", "blocked", true),
        evidence: {
          work: false,
          permissions: 1,
          questions: 0,
          descendants: { unseen: 3, blocked: 2, working: 1, finished: 0 },
        },
      },
    }),
  });
  assertEquals(attentionCount(store, key), 4);
  store.stale(true);
  assertEquals(attentionCount(store, key), 0);
});

Deno.test("clear feedback waits for the visible verdict without demanding off-view entities", async () => {
  const key = entityKey("session", "visible");
  const entries = {
    [key]: {
      ...presentedEntity("session", "visible", "finished", true),
      terminal: 30,
    },
  };
  const store = createEntityStateStore({ read: () => entries });
  const abort = new AbortController();
  let shown = false;
  const result = awaitAcknowledged(store, {
    sessions: [
      { sessionID: "visible", terminal: 30 },
      { sessionID: "off-view", terminal: 31 },
    ],
  }, abort.signal).then(() => {
    shown = true;
  });
  await Promise.resolve();
  assertEquals(shown, false);
  entries[key] = {
    ...presentedEntity("session", "visible", "none"),
    terminal: 30,
  };
  store.observe([key], "live");
  abort.abort();
  await result;
  assertEquals(shown, true);
  store.stop();
});
