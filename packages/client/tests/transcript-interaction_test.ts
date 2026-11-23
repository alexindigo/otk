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

Deno.test("work intent survives a remount with a newly admitted prefix", () => {
  const owner = createTranscriptInteraction();
  owner.workDisclosure("reply", ["edit"]).set(true);
  const mounted = owner.workDisclosure("reply", ["reasoning", "edit"]);
  assertEquals(mounted.expanded("work"), true);
  assertEquals(
    owner.workDisclosure("other-reply", ["edit"]).expanded("work"),
    false,
  );
  assertEquals(
    owner.workDisclosure("reply", ["unrelated"]).expanded("work"),
    false,
  );
  mounted.set(false);
  assertEquals(
    owner.workDisclosure("reply", ["edit"]).expanded("work", {
      expandWork: true,
    }),
    false,
  );
});

Deno.test("work intent can precede the first viewer and is not inherited by a reused native part", () => {
  const owner = createTranscriptInteraction();
  const early = owner.workDisclosure("reply", ["edit"]);
  early.set(true);
  const first = owner.workDisclosure("reply", ["reasoning", "edit"]);
  assertEquals(first.expanded("work"), true);
  owner.retireIdentity("edit");
  early.set(true);
  assertEquals(owner.workDisclosure("reply", ["edit"]).expanded("work"), false);
  assertEquals(
    owner.workDisclosure("reply", ["reasoning"]).expanded("work"),
    true,
  );
});
