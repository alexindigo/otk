// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import * as client from "@otk/client";

Deno.test("fork notes are session-keyed, dismissible and cleared only by successful submission", async () => {
  const notes = client.createForkNotes();
  notes.add("local/a", "Original");
  notes.add("remote/a", "Other server");
  assertEquals(notes.get("local/a"), { from: "Original" });
  await notes.submission("local/a", async () => {});
  assertEquals(notes.get("local/a"), undefined);
  assertEquals(notes.get("remote/a"), { from: "Other server" });
  try {
    await notes.submission(
      "remote/a",
      () => Promise.reject(new Error("Refused")),
    );
  } catch { /* A failed send retains the note. */ }
  assertEquals(notes.get("remote/a"), { from: "Other server" });
  const held = Promise.withResolvers<void>();
  const sending = notes.submission("remote/a", () => held.promise);
  notes.add("remote/a", "Replacement");
  held.resolve();
  await sending;
  assertEquals(notes.get("remote/a"), { from: "Replacement" });
  notes.dismiss("remote/a");
  assertEquals(notes.get("remote/a"), undefined);
});
