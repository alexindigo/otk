// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createTranscriptInteraction } from "../transcript-interaction.ts";

Deno.test("transcript choices retain only identity and reject retired generations", () => {
  const interaction = createTranscriptInteraction();
  const first = interaction.disclosure("reply:a/part:b", "b:1");
  assertEquals(first.value(), undefined);
  first.set(false);
  assertEquals(interaction.disclosure("reply:a/part:b", "b:1").value(), false);
  interaction.retire("reply:a/part:b");
  const replacement = interaction.disclosure("reply:a/part:b", "b:2");
  first.set(true);
  assertEquals(replacement.value(), undefined);
  interaction.anchor({ key: "reply:a", offset: 7 });
  assertEquals(interaction.anchor(), { key: "reply:a", offset: 7 });
  interaction.clear();
  assertEquals(interaction.anchor(), undefined);
});

Deno.test("disclosure notifications target only changed keys and reveal ancestry", () => {
  const interaction = createTranscriptInteraction();
  const seen: string[] = [];
  const release = interaction.subscribe(() => seen.push("a"), "a");
  interaction.subscribe(() => seen.push("b"), "b");
  interaction.disclosure("a", interaction.generation("a")).set(true);
  assertEquals(seen, ["a"]);
  seen.length = 0;
  interaction.reveal(["b"]);
  assertEquals(seen, ["b"]);
  release();
  seen.length = 0;
  interaction.reveal(["a"]);
  assertEquals(seen, []);
});
