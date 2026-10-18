// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { TaskProgress } from "../tasks.ts";
import { mapTool } from "../map-tools.ts";
import type { Info, RawPart } from "../types.ts";
import type { Part } from "@otk/protocol";
const load = async () =>
  JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../tests/fixtures/opencode1/m3-tasks.json",
        import.meta.url,
      ),
    ),
  ) as {
    parent: { info: Info; parts: RawPart[] }[];
    child: { info: Info; parts: RawPart[] }[];
  };
Deno.test("recorded task retains its native result while open-parent progress contains counts, not child transcripts", async () => {
  const data = await load(),
    raw = data.parent.flatMap((m) => m.parts).find((p) => p.tool === "task")!,
    call = mapTool(raw);
  assert(call.tool === "task");
  assertEquals(call.agent, "general");
  assertEquals(call.description, "First inspection");
  assert(call.childSessionID);
  const emitted: Part[] = [];
  const tracker = new TaskProgress(
    (id, message) =>
      Promise.resolve(
        id === raw.sessionID
          ? data.parent.filter((m) => m.info.id === message)
          : data.child,
      ),
    () => true,
    (_parent, _message, part) => emitted.push(part),
    () => {
      throw new Error("Unexpected recovery");
    },
  );
  const shaped = await tracker.shape(raw);
  assertEquals(shaped.toolCount, 1);
  assert((shaped.duration || 0) > 0);
  assertEquals(shaped.output, raw.state!.output);
  assert(!("parts" in shaped));
  const tool = structuredClone(
    data.child.flatMap((m) => m.parts).find((p) => p.type === "tool")!,
  );
  tool.state!.title = "Current changed";
  tracker.observe(tool.sessionID, undefined, tool);
  await new Promise((resolve) => setTimeout(resolve, 90));
  assertEquals(emitted.length, 1);
  const part = emitted[0];
  assert(part.kind === "tool" && part.call.tool === "task");
  assert(part.call.currentTool?.includes("Current changed"));
  tracker.release(raw.sessionID);
  tracker.observe(tool.sessionID, undefined, tool);
  await new Promise((resolve) => setTimeout(resolve, 90));
  assertEquals(emitted.length, 1);
});
Deno.test("late task snapshot cannot reattach summary ownership after unsubscribe", async () => {
  const data = await load(),
    raw = data.parent.flatMap((m) => m.parts).find((p) => p.tool === "task")!;
  let resolve!: (value: typeof data.child) => void;
  const delayed = new Promise<typeof data.child>((r) => {
      resolve = r;
    }),
    emitted: Part[] = [];
  const tracker = new TaskProgress(
    () => delayed,
    () => true,
    (_a, _b, part) => emitted.push(part),
    () => {},
  );
  const shape = tracker.shape(raw);
  tracker.release(raw.sessionID);
  resolve(data.child);
  await shape;
  const tool = data.child.flatMap((m) => m.parts).find((p) =>
    p.type === "tool"
  )!;
  tracker.observe(tool.sessionID, undefined, tool);
  await new Promise((r) => setTimeout(r, 90));
  assertEquals(emitted, []);
});
