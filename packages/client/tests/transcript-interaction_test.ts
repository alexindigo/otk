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

Deno.test("work intent survives a reply remount and overrides the default", () => {
  const owner = createTranscriptInteraction();
  owner.workDisclosure("reply").set(true);
  const mounted = owner.workDisclosure("reply");
  assertEquals(mounted.expanded("work"), true);
  assertEquals(owner.workDisclosure("other-reply").expanded("work"), false);
  assertEquals(owner.workDisclosure("reply").expanded("work"), true);
  mounted.set(false);
  assertEquals(
    owner.workDisclosure("reply").expanded("work", {
      expandWork: true,
    }),
    false,
  );
});

Deno.test("work intent belongs to the reply and is retired with it", () => {
  const owner = createTranscriptInteraction();
  const early = owner.workDisclosure("reply");
  early.set(true);
  assertEquals(owner.workDisclosure("reply").expanded("work"), true);
  owner.retireIdentity("reply");
  assertEquals(early.value(), undefined);
  early.set(true);
  assertEquals(owner.workDisclosure("reply").expanded("work"), false);
});

Deno.test("work intent survives zero members", () => {
  const owner = createTranscriptInteraction();
  owner.workDisclosure("reply").set(true);
  // The first work record goes away; the reply identity is still current.
  owner.retireIdentity("first");
  assertEquals(owner.workDisclosure("reply").expanded("work"), true);
  const remounted = owner.workDisclosure("reply");
  assertEquals(remounted.expanded("work"), true);
  remounted.set(false);
  assertEquals(
    owner.workDisclosure("reply").expanded("work", {
      expandWork: true,
    }),
    false,
  );
});

Deno.test("clearing retires work handles even if the reply generation is reused", () => {
  const owner = createTranscriptInteraction();
  const old = owner.workDisclosure("reply");
  old.set(true);
  owner.clear();
  const fresh = owner.workDisclosure("reply");
  assertEquals(fresh.value(), undefined);
  old.set(true);
  assertEquals(fresh.value(), undefined);
  fresh.set(true);
  assertEquals(old.value(), undefined);
});
