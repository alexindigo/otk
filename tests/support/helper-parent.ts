// SPDX-License-Identifier: LGPL-3.0-only
import type { Info, RawPart } from "@otk/harness-opencode-v1";
import { type BrowserNative, BrowserV2Native } from "./browser-native.ts";
import { v2HelperParent } from "./helper-v2-parent.ts";
/** Real stock API only; expected helper facts are independent of OTK's digest. */
export async function helperParent(oc: BrowserNative) {
  if (oc instanceof BrowserV2Native) return await v2HelperParent(oc);
  const parent = await oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Helper isolation review" },
  });
  const child = await oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Shared helper", parentID: parent.id },
  });
  for (const session of [parent, child]) {
    await oc.request(`/session/${session.id}/message`, {
      method: "POST",
      body: {
        noReply: true,
        parts: [{ type: "text", text: "Inspect helper metadata" }],
      },
    });
  }
  const work = await oc.request<{ info: Info; parts: RawPart[] }>(
    `/session/${child.id}/shell`,
    {
      method: "POST",
      body: { agent: "build", command: "printf helper-result" },
    },
  );
  const tool = work.parts.find((part) => part.type === "tool")!;
  for (let n = 0; n < 10; n++) {
    const carrier = await oc.request<{ info: Info; parts: RawPart[] }>(
      `/session/${parent.id}/shell`,
      {
        method: "POST",
        body: { agent: "build", command: `printf parent-${n}` },
      },
    );
    const original = carrier.parts.find((part) => part.type === "tool")!;
    const task = (
      id: string,
      callID: string | undefined,
      description: string,
    ) =>
      oc.request(
        `/session/${parent.id}/message/${carrier.info.id}/part/${id}`,
        {
          method: "PATCH",
          body: {
            ...original,
            id,
            callID,
            tool: "task",
            state: {
              ...original.state,
              input: {
                description,
                subagent_type: "general",
                prompt: "Inspect",
              },
              metadata: { sessionId: child.nativeID },
            },
          },
        },
      );
    await task(original.id, original.callID, `Inspection ${n + 1}`);
    // D74 / wl-5: Work inspects one reply. Keep two references to the same
    // native helper in the last reply so both held progress cards can paint.
    if (n === 9) {
      const duplicate = crypto.randomUUID().replaceAll("-", "");
      await task(`prt_${duplicate}`, `call_${duplicate}`, "Confirm inspection");
    }
  }
  return { parent, child, work, tool };
}
