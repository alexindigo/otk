// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  type ContextMessage,
  DEFAULT_PREFS,
  type ExternalPart,
  type Part,
} from "@otk/protocol";
import { PartRegistry } from "../registries/renderers.ts";
import { hasActiveRecord, messageFrames } from "../components/work-log.ts";
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

Deno.test("declared fallback content copies its exact payload and explicit registrations keep their own framing", () => {
  const parts = new PartRegistry();
  parts.fallback(() => "generic", unknownPartPresentation);
  const source = {
    kind: "acme/flux",
    preview: "not the source",
    bytes: 100,
    truncated: true,
    payload: "  <flux>**raw**</flux>\n",
  };
  // Copy is the producer-declared content, exactly as sent; undeclared source
  // remains inspection-only.
  const presentation = parts.presentation(
    { ...part, source, content: true },
    DEFAULT_PREFS,
  );
  assertEquals(presentation.copyable, true);
  assertEquals(presentation.text, source.payload);
  const inspected = parts.presentation({ ...part, source }, DEFAULT_PREFS);
  assertEquals(inspected.copyable, false);
  assertEquals(inspected.text, undefined);
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
Deno.test("reply copy carries only producer-declared content; row records join the reply's work, never its copy", () => {
  const parts = new PartRegistry();
  parts.fallback(() => "generic", unknownPartPresentation);
  parts.registerTyped("text", () => "text", () => ({
    copyable: true,
    text: "Reply text",
  }));
  const source = (payload: string) => ({
    kind: "acme/source",
    preview: payload,
    bytes: payload.length,
    truncated: false,
    payload,
  });
  const record = (id: string, layout: "row" | "boundary"): ExternalPart => ({
    kind: "external",
    id,
    name: "acme/step",
    source: source(`{"type":"${id}"}`),
    activity: {
      kindLabel: "Step",
      layout,
      category: "record",
      title: id,
      tone: "normal",
    },
  });
  const declared: ExternalPart = {
    ...record("context", "row"),
    source: source("Exact sent text"),
    content: true,
  };
  const present = (part: Part) => parts.presentation(part, DEFAULT_PREFS);
  // Bookkeeping stays inspectable through source but is never copy content.
  assertEquals(present(record("start", "row")).copyable, false);
  assertEquals(present(record("start", "row")).text, undefined);
  assertEquals(present(declared).text, "Exact sent text");
  assertEquals(present(declared).copyable, true);
  const replyParts: Part[] = [
    record("start", "row"),
    { kind: "text", id: "text", blocks: [], synthetic: false },
    record("finish", "row"),
    record("interrupted", "boundary"),
  ];
  // Copy composes presentation text: only the reply's own content remains.
  assertEquals(
    replyParts.map((part) => present(part).text).filter(Boolean),
    ["Reply text"],
  );
  // Inside a reply a row record is work in the reply's own flow; a boundary
  // still stands in the transcript.
  const reply = createMessageLayout().update(
    "reply",
    "assistant",
    [{ messageID: "reply", parts: replyParts }],
    "",
    (part) => parts.presentation(part, DEFAULT_PREFS),
  );
  assertEquals(reply.frames.map((frame) => frame.transcript), [false, true]);
  assertEquals(
    reply.frames[0].groups.map((group) => group.work),
    [true, false, true],
  );
  assertEquals(reply.copyable, true);
  // Outside replies, records keep their transcript frame and no work log.
  const context = createMessageLayout().update(
    "context",
    "context",
    [{ messageID: "context", parts: [declared] }],
    "",
    (part) => parts.presentation(part, DEFAULT_PREFS),
  );
  assertEquals(context.frames.map((frame) => frame.transcript), [true]);
  assertEquals(context.frames[0].groups[0].work, false);
  assertEquals(context.copyable, true);
});
Deno.test("only a plugin-reported running record is active work", () => {
  const record = (active: boolean | null): ContextMessage => ({
    id: "record",
    sessionID: "acmv1-session",
    role: "context",
    time: { created: 1 },
    parts: [{
      ...part,
      activity: {
        ...part.activity!,
        state: {
          key: "beyond",
          label: "Beyond",
          facts: { active, terminal: null },
        },
      },
    }],
  });
  assertEquals(hasActiveRecord(record(true)), true);
  // Unknown is never treated as running.
  assertEquals(hasActiveRecord(record(null)), false);
  assertEquals(hasActiveRecord(record(false)), false);
});
