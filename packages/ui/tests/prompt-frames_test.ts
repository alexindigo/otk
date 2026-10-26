// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DEFAULT_PREFS, type Message, type Part } from "@otk/protocol";
import {
  type PartPresentation,
  PartRegistry,
} from "../registries/renderers.ts";
import * as framing from "../components/work-log.ts";

Deno.test("shared message framing owns prompt visibility for markers, hidden parts, mixed content and empty messages", () => {
  const project = Reflect.get(framing, "messageFrames") as
    | undefined
    | ((
      message: Pick<Message, "id" | "role" | "parts">,
      presentation: (part: Part) => PartPresentation,
    ) => { frames: framing.PartFrame[]; prompt: boolean });
  assert(project, "Missing shared message-frame projection");
  const registry = new PartRegistry();
  registry.register("marker", () => "marker", () => ({ frame: "transcript" }));
  registry.register("hidden", () => null, () => ({ hidden: true }));
  const text: Part = { id: "text", kind: "text", synthetic: false, blocks: [] };
  const marker: Part = { id: "marker", kind: "external", name: "marker" };
  const hidden: Part = { id: "hidden", kind: "external", name: "hidden" };
  const present = (part: Part) => registry.presentation(part, DEFAULT_PREFS);
  for (
    const [parts, expected] of [
      [[], false],
      [[hidden], false],
      [[marker], false],
      [[marker, hidden], false],
      [[text], true],
      [[marker, text, hidden], true],
      [[text, marker], true],
    ] as [Part[], boolean][]
  ) {
    const value = project({ id: "m", role: "user", parts }, present);
    assertEquals(value.prompt, expected);
    assertEquals(value.frames, framing.partFrames(parts, present));
  }
  const assistant = project(
    { id: "reply", role: "assistant", parts: [] },
    present,
  );
  assertEquals(assistant.prompt, false);
  assertEquals(assistant.frames, [{
    id: "reply",
    parts: [],
    transcript: false,
  }]);
});
