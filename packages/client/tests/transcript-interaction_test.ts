// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createDisclosures } from "../disclosure.ts";
import { createTranscriptInteraction } from "../transcript-interaction.ts";

Deno.test("binding another disclosure of the same kind does not lose an explicit choice", () => {
  const interaction = createTranscriptInteraction();
  const first = interaction.disclosure("record", "first", "1");
  first.set(true);
  const second = interaction.disclosure("record", "second", "1");
  assertEquals(second.value(), undefined);
  assertEquals(first.value(), true);
});

Deno.test("shell transcripts share the owner but clear only their own session scope", () => {
  const disclosures = createDisclosures({});
  const first = createTranscriptInteraction(disclosures, "local/first");
  const next = createTranscriptInteraction(disclosures, "local/second");
  first.disclosure("activity", "reply", first.generation("reply")).set(true);
  next.disclosure("activity", "reply", next.generation("reply")).set(true);
  const sidebar = disclosures.bind("archive", { scope: "local", id: "repo" });
  void sidebar.set(true);
  assertEquals(
    disclosures.bind("activity", {
      scope: "local/first",
      id: "reply",
      generation: first.generation("reply"),
    }).open(),
    true,
  );
  first.clear();
  assertEquals(
    first.disclosure("activity", "reply", first.generation("reply")).value(),
    undefined,
  );
  assertEquals(
    next.disclosure("activity", "reply", next.generation("reply")).value(),
    true,
  );
  assertEquals(sidebar.open(), true);
});

Deno.test("transcript choices retain only identity and reject retired generations", () => {
  const interaction = createTranscriptInteraction();
  const first = interaction.disclosure("record", "reply:a/part:b", "b:1");
  assertEquals(first.value(), undefined);
  first.set(false);
  assertEquals(
    interaction.disclosure("record", "reply:a/part:b", "b:1").value(),
    false,
  );
  interaction.retire("reply:a/part:b");
  const replacement = interaction.disclosure("record", "reply:a/part:b", "b:2");
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
  const release = interaction.subscribe(
    () => seen.push("a"),
    "activity",
    "a",
    interaction.generation("a"),
  );
  interaction.subscribe(
    () => seen.push("b"),
    "activity",
    "b",
    interaction.generation("b"),
  );
  interaction.disclosure("activity", "a", interaction.generation("a")).set(
    true,
  );
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
  owner.disclosure("activity", "reply", owner.generation("reply")).set(true);
  const mounted = owner.disclosure(
    "activity",
    "reply",
    owner.generation("reply"),
  );
  assertEquals(mounted.expanded("system"), true);
  assertEquals(
    owner.disclosure("activity", "other-reply", owner.generation("other-reply"))
      .expanded("system"),
    false,
  );
  assertEquals(
    owner.disclosure("activity", "reply", owner.generation("reply")).expanded(
      "system",
    ),
    true,
  );
  mounted.set(false);
  assertEquals(
    owner.disclosure("activity", "reply", owner.generation("reply")).expanded(
      "system",
      {
        expandSystem: true,
      },
    ),
    false,
  );
});

Deno.test("work intent belongs to the reply and is retired with it", () => {
  const owner = createTranscriptInteraction();
  const early = owner.disclosure(
    "activity",
    "reply",
    owner.generation("reply"),
  );
  early.set(true);
  assertEquals(
    owner.disclosure("activity", "reply", owner.generation("reply")).expanded(
      "system",
    ),
    true,
  );
  owner.retireIdentity("reply");
  assertEquals(early.value(), undefined);
  early.set(true);
  assertEquals(
    owner.disclosure("activity", "reply", owner.generation("reply")).expanded(
      "system",
    ),
    false,
  );
});

Deno.test("work intent survives zero members", () => {
  const owner = createTranscriptInteraction();
  owner.disclosure("activity", "reply", owner.generation("reply")).set(true);
  // The first work record goes away; the reply identity is still current.
  owner.retireIdentity("first");
  assertEquals(
    owner.disclosure("activity", "reply", owner.generation("reply")).expanded(
      "system",
    ),
    true,
  );
  const remounted = owner.disclosure(
    "activity",
    "reply",
    owner.generation("reply"),
  );
  assertEquals(remounted.expanded("system"), true);
  remounted.set(false);
  assertEquals(
    owner.disclosure("activity", "reply", owner.generation("reply")).expanded(
      "system",
      {
        expandSystem: true,
      },
    ),
    false,
  );
});

Deno.test("clearing retires work handles even if the reply generation is reused", () => {
  const owner = createTranscriptInteraction();
  const old = owner.disclosure("activity", "reply", owner.generation("reply"));
  old.set(true);
  owner.clear();
  const fresh = owner.disclosure(
    "activity",
    "reply",
    owner.generation("reply"),
  );
  assertEquals(fresh.value(), undefined);
  old.set(true);
  assertEquals(fresh.value(), undefined);
  fresh.set(true);
  assertEquals(old.value(), undefined);
});
