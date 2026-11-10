// SPDX-License-Identifier: LGPL-3.0-only
import type { BrowserV2Native } from "./browser-native.ts";

/** Initial native projection only: stock V2 import replaces V1's mutable parts. */
export async function v2HelperParent(oc: BrowserV2Native) {
  const childID = "ses_" + crypto.randomUUID().replaceAll("-", "");
  const promptID = "msg_" + crypto.randomUUID().replaceAll("-", "");
  const workID = "msg_" + crypto.randomUUID().replaceAll("-", "");
  const toolID = "call_" + crypto.randomUUID();
  const now = Date.now();
  const parent = await oc.seedSession({ title: "Helper isolation review" }, [
    { type: "user", text: "Inspect helper metadata" },
    ...Array.from({ length: 10 }, (_, n) => ({
      type: "assistant",
      agent: "build",
      model: { providerID: "fake", id: "scripted" },
      time: { created: now + n + 1, completed: now + n + 1 },
      content: [{
        type: "tool",
        id: `call_parent_${n}`,
        name: "subagent",
        time: { created: now + n + 1, completed: now + n + 1 },
        state: {
          status: "completed",
          input: {
            description: `Inspection ${n + 1}`,
            agent: "general",
            prompt: "Inspect",
          },
          content: [{ type: "text", text: "Helper completed" }],
          metadata: { sessionID: childID },
        },
      }],
    })),
  ]);
  const child = await oc.seedSession({
    id: childID,
    title: "Shared helper",
    parentID: parent.id,
  }, [
    { type: "user", id: promptID, text: "Inspect helper metadata" },
    {
      type: "assistant",
      id: workID,
      agent: "build",
      model: { providerID: "fake", id: "scripted" },
      time: { created: now + 1, completed: now + 2 },
      content: [{
        type: "tool",
        id: toolID,
        name: "shell",
        time: { created: now + 1, completed: now + 2 },
        state: {
          status: "completed",
          input: {
            command: "printf helper-result",
            description: "Helper result",
          },
          content: [{ type: "text", text: "helper-result" }],
          metadata: { output: "helper-result", exit: 0 },
        },
      }],
    },
  ]);
  return {
    parent,
    child,
    work: { info: { id: workID, promptID } },
    tool: { id: toolID },
  };
}
