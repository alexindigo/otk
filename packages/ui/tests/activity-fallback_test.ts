// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  type ContextMessage,
  DEFAULT_PREFS,
  type ExternalPart,
} from "@otk/protocol";
import { PartRegistry } from "../registries/renderers.ts";
import { messageFrames } from "../components/work-log.ts";
import { createMessageLayout } from "../components/message-layout.ts";
import {
  unknownPartPresentation,
  unknownPartPreview,
} from "../components/parts/unknown-part.ts";

const part: ExternalPart = {
  kind: "external",
  id: "part",
  name: "acme/flux",
  activity: {
    kindLabel: "Flux",
    layout: "row",
    category: "record",
    title: "Flux settled",
    detail: "Native detail",
    tone: "error",
    state: {
      key: "beyond",
      label: "Beyond",
      facts: { active: null, terminal: null },
    },
  },
};

Deno.test("fallback contributes generic activity presentation without a kind registration", () => {
  const parts = new PartRegistry();
  parts.fallback(
    () => "generic",
    unknownPartPresentation,
  );
  assert(parts.resolve(part));
  assertEquals(parts.presentation(part, DEFAULT_PREFS).frame, "transcript");
  assertEquals(parts.presentation(part, DEFAULT_PREFS).required, true);
  const message: ContextMessage = {
    id: "notice",
    sessionID: "acmv1-session",
    role: "context",
    time: { created: 1 },
    parts: [part],
  };
  assertEquals(
    messageFrames(message, (part) => parts.presentation(part, DEFAULT_PREFS))
      .userBubble,
    false,
  );
  const result = createMessageLayout().update(
    message.id,
    message.role,
    [{ messageID: message.id, parts: message.parts }],
    "",
    (part) => parts.presentation(part, DEFAULT_PREFS),
  );
  assertEquals(result.userBubble, false);
  assertEquals(result.prompt, false);
  assertEquals(result.frames[0].transcript, true);
});

Deno.test("fallback source is exact payload and explicit registrations keep their own framing", () => {
  const parts = new PartRegistry();
  parts.fallback(() => "generic", unknownPartPresentation);
  const source = {
    kind: "acme/flux",
    preview: "not the source",
    bytes: 100,
    truncated: true,
    payload: "  <flux>**raw**</flux>\n",
  };
  const presentation = parts.presentation({ ...part, source }, DEFAULT_PREFS);
  assertEquals(presentation.copyable, true);
  assertEquals(presentation.text, source.payload);
  parts.register(part.name, () => "custom");
  assertEquals(parts.presentation(part, DEFAULT_PREFS), {});
  const other = new PartRegistry();
  other.fallback(() => "generic", unknownPartPresentation);
  assertEquals(other.presentation(part, DEFAULT_PREFS).frame, "transcript");
});

// Ported from INV-A's bubble projection cases. Native mapping belongs to NT2.
for (const origin of ["system", "synthetic", "skill"] as const) {
  Deno.test(`legacy ${origin} context no longer receives an injected user bubble`, () => {
    const message = {
      id: origin,
      role: "user" as const,
      origin,
      parts: [part],
    };
    assertEquals(messageFrames(message, () => ({})).userBubble, false);
    assertEquals(messageFrames(message, () => ({})).prompt, false);
  });
}

Deno.test("unknown parts show bounded data and preserve the producer's truncation fact", () => {
  assertEquals(
    unknownPartPreview({ kind: "external", id: "empty", name: "acme/empty" }),
    undefined,
  );
  assertEquals(
    unknownPartPreview({
      kind: "external",
      id: "data",
      name: "acme/new",
      data: "raw data",
    }),
    { text: "raw data", bytes: 8, truncated: false },
  );
  const bounded = unknownPartPreview({ ...part, data: "€".repeat(20_000) })!;
  assert(bounded.text.length > 0);
  assert(new TextEncoder().encode(bounded.text).length <= 16 * 1024);
  assertEquals(bounded.text.includes("\ufffd"), false);
  assertEquals(bounded.truncated, true);
  assertEquals(bounded.bytes, 60_000);
  assertEquals(
    unknownPartPreview({
      ...part,
      source: {
        kind: "acme/flux",
        preview: "prefix",
        bytes: 99,
        truncated: true,
        payload: "complete source",
      },
    }),
    { text: "prefix", bytes: 99, truncated: true },
  );
});
