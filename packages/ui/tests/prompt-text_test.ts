// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapMessage } from "@otk/harness-opencode-v1";
import { blocksText } from "../components/parts/text.ts";

Deno.test("the prompt text renderer's copy source preserves literal input", () => {
  const text = "First line\nSecond line\n\n    **Indented third line**\n";
  const message = mapMessage({
    id: "msg_prompt",
    sessionID: "ses_prompt",
    role: "user",
    time: { created: 1 },
  }, [{
    id: "prt_text",
    sessionID: "ses_prompt",
    messageID: "msg_prompt",
    type: "text",
    text,
  }]);
  const part = message.parts[0];
  if (part.kind !== "text") throw new Error("Expected a prompt text part");
  assertEquals(blocksText(part.blocks), text);
});
