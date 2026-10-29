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
