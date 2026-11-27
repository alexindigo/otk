// SPDX-License-Identifier: LGPL-3.0-only
import {
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
} from "@std/assert";
import type { TranscriptReply } from "@otk/client";
import type { Part } from "@otk/protocol";
import { DEFAULT_PREFS } from "@otk/protocol";
import { PartRegistry } from "../registries/renderers.ts";
import type { PartPresentation } from "../registries/renderers.ts";
import {
  createWorkModel,
  partFrames,
  partGroups,
  WORK_STRIP_MAX_SEGMENTS,
  workRuns,
} from "../components/work-log.ts";
import { relativeTarget } from "../components/tools/paths.ts";
import { blocksText } from "../components/parts/text.ts";
import { unknownPartPresentation } from "../components/parts/unknown-part.ts";

function workFixture() {
  const parts: Part[] = [];
  const facts = new Map<string, PartPresentation>();
  let cursor = 0;
  function add(part: Part, value?: PartPresentation) {
    parts.push(part);
    if (value) facts.set(part.id, value);
  }
  function action(
    id: string,
    label: string,
    duration: number,
    run?: Partial<NonNullable<PartPresentation["run"]>>,
  ) {
    add({ kind: "meta", id }, {
      work: { start: cursor, end: cursor + duration },
      run: { label, ...run },
    });
    cursor += duration;
  }
  function step(n: number, thinking: number, actions: () => void) {
    add({ kind: "step", id: `step-${n}-start`, phase: "start" });
    action(`thought-${n}`, "Thought", thinking, { lane: "thinking" });
    actions();
    add({ kind: "step", id: `step-${n}-finish`, phase: "finish" });
  }
  const presentation = (part: Part) =>
    facts.get(part.id) ?? unknownPartPresentation(part);
  return { parts, add, action, step, facts, presentation };
}

const readFacts = {
  merge: { key: "tool:read", verb: "Read", noun: "file", plural: "files" },
};

Deno.test("2.115 sample reply: five rows, seven actions, no step or completion rows", () => {
  const { parts, add, action, step, presentation } = workFixture();
  const update = (done: number) =>
    action(`tasks-${done}/3`, "Update tasks", 10, {
      merge: {
        key: "tool:todo",
        verb: "Update tasks",
        noun: "update",
        plural: "updates",
        keep: "latest",
      },
    });
  step(1, 4200, () => {
    update(0);
    action("read-css", "Read SidebarRow.css", 10, readFacts);
    action("read-spec", "Read sidebar-row-geometry.spec.ts", 10, readFacts);
    action("read-tree", "Read session-tree.ts", 10, readFacts);
  });
  step(2, 8400, () => {
    action(
      "task",
      "explore: Find where 1.19.3 session rows get their meta",
      62_000,
      { lane: "delegation", child: "explore" },
    );
    update(1);
  });
  step(3, 4300, () => {
    action("edit", "Edited SidebarRow.css", 10);
    update(2);
  });
  step(4, 3500, () => {
    action("bash", "Run the sidebar spec on 1.19.3", 38_000);
    update(3);
  });
  add({ kind: "text", id: "answer", synthetic: false, blocks: [] });
  add({
    kind: "external",
    id: "completion",
    name: "execution-end",
    activity: {
      category: "record",
      kindLabel: "Execution",
      title: "Execution succeeded",
      layout: "row",
      completion: { placement: "footer" },
      tone: "normal",
    },
  });

  const result = workRuns({ parts, presentation, terminal: true, now: 0 });
  assertEquals(result.runs.map((run) => run.label), [
    "Read 3 files",
    "explore: Find where 1.19.3 session rows get their meta",
    "Edited SidebarRow.css",
    "Run the sidebar spec on 1.19.3",
    "Update tasks",
  ]);
  assertEquals(result.actions, 7);
  assertEquals(result.failed, []);
  assertEquals(result.live, undefined);
  assertEquals(result.runs[0].partIDs, ["read-css", "read-spec", "read-tree"]);
  assertEquals(result.runs.at(-1)?.partIDs, ["tasks-3/3"]);
  assertEquals(result.runs.map((run) => run.thinkingMs), [
    4200,
    8400,
    4300,
    3500,
    undefined,
  ]);
  const thinking = result.segments.filter((segment) =>
    segment.lane === "thinking"
  );
  assertEquals(thinking.map((segment) => segment.weightMs), [
    4200,
    8400,
    4300,
    3500,
  ]);
  assertEquals(
    thinking.reduce((sum, segment) => sum + segment.weightMs, 0),
    20_400,
  );
  assertEquals(thinking.map((segment) => segment.run), [
    "read-css",
    "task",
    "edit",
    "bash",
  ]);
  assertEquals(result.runOf("read-tree"), "read-css");
  assertEquals(result.runOf("thought-1"), "read-css");
  assertEquals(result.runOf("answer"), undefined);
  assertEquals(result.bookkeeping.map((part) => part.id), [
    "step-1-start",
    "step-1-finish",
    "step-2-start",
    "step-2-finish",
    "step-3-start",
    "step-3-finish",
    "step-4-start",
    "step-4-finish",
    "completion",
  ]);
  for (const item of result.bookkeeping) {
    assertEquals(result.runOf(item.id), undefined);
  }
});

Deno.test("composer header sample: four actions and one failed run remain explicit", () => {
  const { parts, action, step, facts, presentation } = workFixture();
  step(1, 2100, () => action("v2", "Run the header spec on 2.2.6", 31_000));
  step(2, 1400, () => action("v1", "Run the header spec on 1.19.3", 44_000));
  facts.get("v1")!.required = true;
  step(3, 6000, () => {
    action("read-spec", "Read header-row.spec.ts", 10, readFacts);
    action("read-css", "Read Terminal.css", 10, readFacts);
  });
  const result = workRuns({ parts, presentation, terminal: true, now: 0 });
  assertEquals(result.actions, 4);
  assertEquals(result.failed.map((run) => run.key), ["v1"]);
  assertEquals(result.segments.find((segment) => segment.failed)?.run, "v1");
  assertEquals(
    result.summary,
    "Work log: 4 actions, 1 failed. Run the header spec on 2.2.6; Run the header spec on 1.19.3 (failed); Read 2 files",
  );
});

Deno.test("only the final task update remains, without interrupting a read run", () => {
  const { parts, action, presentation } = workFixture();
  const latest = {
    merge: {
      key: "updates",
      verb: "Update tasks",
      noun: "update",
      plural: "updates",
      keep: "latest" as const,
    },
  };
  action("a", "Read a", 100, readFacts);
  action("update-first", "Update tasks", 100, latest);
  action("b", "Read b", 100, readFacts);
  action("update-last", "Update tasks", 100, latest);
  const result = workRuns({ parts, presentation, terminal: true, now: 0 });
  assertEquals(result.runs.map((run) => [run.key, run.partIDs]), [
    ["a", ["a", "b"]],
    ["update-last", ["update-last"]],
  ]);
  assertEquals(result.actions, 3);
  assertEquals(result.runOf("update-first"), undefined);
  assertEquals(
    workRuns({ parts: parts.slice(0, 1), presentation, terminal: true, now: 0 })
      .runs[0].key,
    result.runs[0].key,
  );
});

Deno.test("run membership follows the part owner's visibility and retains untimed work", () => {
  const parts: Part[] = [
    { kind: "meta", id: "successful-tool" },
    { kind: "meta", id: "hidden" },
    { kind: "external", name: "op", id: "failed-tool" },
    {
      kind: "external",
      id: "delegate",
      name: "helper",
      activity: {
        kindLabel: "Delegate",
        category: "delegation",
        layout: "row",
        title: "Investigate",
        child: { sessionID: "child", label: "Explore" },
        tone: "normal",
      },
    },
  ];
  const present = (part: Part, toolDetails: boolean): PartPresentation => {
    if (part.id === "successful-tool") {
      return { work: toolDetails ? {} : undefined };
    }
    if (part.id === "failed-tool") return { work: {}, required: true };
    if (part.id === "hidden") return { work: {}, hidden: true };
    return unknownPartPresentation(part);
  };
  const input = { parts, terminal: true, now: 0 };
  assertEquals(
    workRuns({ ...input, presentation: (part) => present(part, true) }).actions,
    3,
  );
  const result = workRuns({
    ...input,
    presentation: (part) => present(part, false),
  });
  assertEquals(
    result.runs.map((run) => [run.key, run.lane, run.label, run.child]),
    [
      ["failed-tool", "action", "external", undefined],
      ["delegate", "delegation", "Investigate", "child"],
    ],
  );
  assertEquals(
    result.segments.map((segment) => [segment.run, segment.weightMs]),
    [["failed-tool", 0], ["delegate", 0]],
  );
});

Deno.test("strip compacts 80 alternating rows, preserving failed and active segments", () => {
  const { parts, action, facts, presentation } = workFixture();
  for (let index = 0; index < 80; index++) {
    action(`row-${index}`, `Action ${index}`, 1000);
    action(`thought-${index}`, "Thought", index + 1, { lane: "thinking" });
  }
  facts.get("row-40")!.required = true;
  const work = facts.get("row-79")!.work!;
  delete work.end;
  const input = { parts, presentation, terminal: false };
  const result = workRuns({ ...input, now: work.start! + 1200 });
  const later = workRuns({ ...input, now: work.start! + 2400 });
  assertEquals(result.runs.length, 80);
  assertEquals(result.segments.length, WORK_STRIP_MAX_SEGMENTS);
  assertEquals(
    result.segments.filter((segment) => segment.failed).map((
      segment,
    ) => [segment.run, segment.weightMs]),
    [["row-40", 1000]],
  );
  assertEquals(result.live?.key, "row-79");
  assertEquals(
    result.segments.filter((segment) => segment.live).map((
      segment,
    ) => [segment.run, segment.weightMs]),
    [["row-79", 1200]],
  );
  assertEquals(later.segments.find((segment) => segment.live)?.weightMs, 2400);
  assertEquals(
    workRuns({ ...input, terminal: true, now: 100_000 }).live,
    undefined,
  );
});

Deno.test("work model shares each reply revision and updates live weights without reprojection", () => {
  const part: Part = { kind: "meta", id: "bash" };
  const message: TranscriptReply["message"] = {
    id: "a",
    sessionID: "s",
    role: "assistant",
    agent: "build",
    time: { created: 0 },
    parts: [part],
    model: { provider: "fixture", model: "fixture" },
    tokens: {
      input: null,
      output: null,
      reasoning: null,
      cache: { read: null, write: null },
    },
    cost: null,
    interrupted: false,
  };
  const reply: TranscriptReply = {
    key: "reply:p",
    firstID: "a",
    lastID: "b",
    messageIDs: ["a", "b"],
    segments: [
      { messageID: "a", parts: [] },
      { messageID: "b", parts: [part] },
    ],
    message,
    revision: 1,
  };
  let now = 1000, preference = true, calls = 0;
  const model = createWorkModel({
    reply: (key) => key === reply.key ? reply : undefined,
    replyKeys: () => ["missing", reply.key],
    presentation: () => {
      calls++;
      return { work: preference ? { start: 0 } : undefined };
    },
    presentationRevision: () => preference,
    now: () => now,
  });
  assertEquals(model.turns(), [reply.key]);
  const first = model.runs(reply.key)!;
  assertEquals(first.segments[0].weightMs, 1000);
  now = 2000;
  assertStrictEquals(model.runs(reply.key), first);
  assertEquals(first.segments[0].weightMs, 2000);
  assertEquals(calls, 1);
  reply.revision++;
  assertNotStrictEquals(model.runs(reply.key), first);
  assertEquals(calls, 2);
  preference = false;
  assertEquals(model.turns(), []);
  assertEquals(calls, 3);
});

Deno.test("reply Work log projects actions and failures, not step or success bookkeeping", () => {
  const marker: Part = {
    id: "native-marker",
    kind: "external",
    name: "step-finish",
    activity: {
      category: "stepMarkers",
      fold: true,
      kindLabel: "Step",
      layout: "row",
      title: "Step finished",
      tone: "normal",
    },
  };
  const success: Part = {
    ...marker,
    id: "success",
    activity: {
      ...marker.activity!,
      category: "record",
      completion: { placement: "footer" },
      title: "Execution succeeded",
    },
  };
  const failedStep: Part = {
    ...marker,
    id: "failed-step",
    activity: { ...marker.activity!, title: "Step failed", tone: "error" },
  };
  const failedExecution: Part = {
    ...success,
    id: "failed-execution",
    activity: {
      ...success.activity!,
      title: "Execution failed",
      tone: "error",
    },
  };
  const snapshot: Part = {
    ...marker,
    id: "snapshot",
    activity: { ...marker.activity!, category: "snapshots" },
  };
  const input: Part[] = [
    { id: "step-start", kind: "step", phase: "start" },
    marker,
    snapshot,
    { id: "step-end", kind: "step", phase: "finish" },
    failedStep,
    failedExecution,
    success,
  ];
  const present = () => ({ work: {} });
  assertEquals(partGroups(input, present)[0].parts, [
    snapshot,
    failedStep,
    failedExecution,
  ]);
  assertEquals(partGroups([marker, success], present), []);
  assertEquals(input.length, 7);
});

for (const hidden of [false, true]) {
  Deno.test(`segment busy evidence includes separate hidden=${hidden} reply wait witnesses`, () => {
    const part = (id: string): Part => ({ kind: "meta", id });
    const input = [
      part("first"),
      part("text"),
      part("second"),
      part("question"),
      part("split"),
      part("unknown"),
    ];
    const present = (value: Part) =>
      value.id === "first"
        ? { work: { start: 0, end: 700 }, timing: { start: 0, end: 700 } }
        : value.id === "second"
        ? {
          work: { start: 1000, end: 2200 },
          timing: { start: 1000, end: 2200 },
        }
        : value.id === "question"
        ? { hidden, timing: { start: 1200, end: 1500, waitsForUser: true } }
        : value.id === "unknown"
        ? { work: {} }
        : {};
    assertEquals(
      partGroups(input, present).filter((group) => group.work).map((group) =>
        group.workingMs
      ),
      [1600],
    );
    assertEquals(input.map((part) => part.id), [
      "first",
      "text",
      "second",
      "question",
      "split",
      "unknown",
    ]);
  });
}

Deno.test("work groups preserve ordering, external ownership, missing clocks and consumer isolation", () => {
  const registry = new PartRegistry(), other = new PartRegistry();
  registry.register(
    "step",
    () => "step",
    (part) => ({
      work: JSON.parse(part.data!),
      timing: JSON.parse(part.data!),
    }),
  );
  const input: Part[] = [
    { id: "a", kind: "text", blocks: [], synthetic: false },
    { id: "b", kind: "external", name: "step", data: '{"start":10,"end":20}' },
    { id: "c", kind: "external", name: "step", data: '{"start":15,"end":30}' },
    { id: "d", kind: "text", blocks: [], synthetic: false },
    { id: "e", kind: "external", name: "step", data: '{"start":40}' },
  ];
  const groups = partGroups(
    input,
    (part) => registry.presentation(part, DEFAULT_PREFS),
  );
  assertEquals(
    groups.map((group) => [group.work, group.parts.map((part) => part.id)]),
    [[false, ["a"]], [false, ["d"]], [true, ["b", "c", "e"]]],
  );
  // Incomplete clocks cannot manufacture a duration from the turn's wall time.
  assertEquals(groups.map((group) => group.workingMs), [
    undefined,
    undefined,
    undefined,
  ]);
  assertEquals(groups.map((group) => Object.hasOwn(group, "time")), [
    false,
    false,
    false,
  ]);
  assertEquals(
    partGroups(input, (part) => other.presentation(part, DEFAULT_PREFS))
      .length,
    5,
  );
  assertEquals(input.map((part) => part.id), ["a", "b", "c", "d", "e"]);
});
Deno.test("path targets are lexical project-relative paths without corrupting prefixes or nonpaths", () => {
  for (
    const [path, directory, expected] of [
      ["/work/project/src/a.ts", "/work/project", "src/a.ts"],
      ["/work/project-old/a.ts", "/work/project/", "/work/project-old/a.ts"],
      [
        "/work/project/../outside/a.ts",
        "/work/project/.",
        "/work/project/../outside/a.ts",
      ],
      ["/work/project", "/work/project", "."],
      ["src/a.ts", "/work/project", "src/a.ts"],
      ["https://example.test/a", "/work/project", "https://example.test/a"],
      ["/work/project/a", undefined, "/work/project/a"],
    ]
  ) assertEquals(relativeTarget(path!, directory), expected);
});

Deno.test("feature-contributed transcript framing separates markers from contiguous ordinary content without a kind dispatcher", () => {
  const registry = new PartRegistry();
  registry.register("marker", () => "marker", () => ({ frame: "transcript" }));
  registry.register("hidden", () => null, () => ({ hidden: true }));
  const input: Part[] = [
    { id: "text", kind: "text", synthetic: false, blocks: [] },
    { id: "file", kind: "file", mime: "text/plain", name: "fixture" },
    { id: "hidden", kind: "external", name: "hidden" },
    { id: "marker", kind: "external", name: "marker" },
    { id: "after", kind: "text", synthetic: false, blocks: [] },
  ];
  const frames = partFrames(
    input,
    (part) => registry.presentation(part, DEFAULT_PREFS),
  );
  assertEquals(
    frames.map((
      frame,
    ) => [frame.transcript, frame.parts.map((part) => part.id)]),
    [[false, ["text", "file"]], [true, ["marker"]], [false, ["after"]]],
  );
  assertEquals(input.map((part) => part.id), [
    "text",
    "file",
    "hidden",
    "marker",
    "after",
  ]);
});
Deno.test("copy text uses source blocks including rich inline, lists, code and tables", () => {
  assertEquals(
    blocksText([
      {
        b: "paragraph",
        inline: [
          { i: "text", text: "Hello " },
          { i: "strong", inline: [{ i: "text", text: "world" }] },
          { i: "break" },
          { i: "image", src: "file", alt: "diagram" },
        ],
      },
      {
        b: "list",
        ordered: false,
        items: [{
          blocks: [{
            b: "paragraph",
            inline: [{ i: "code", text: "source.ts" }],
          }],
        }],
      },
      { b: "code", text: "const x = 1;" },
      {
        b: "table",
        align: [null],
        header: [[{ i: "text", text: "Name" }]],
        rows: [[[{ i: "text", text: "OTK" }]]],
      },
    ]),
    "Hello world\ndiagram\n\nsource.ts\n\nconst x = 1;\n\nName\nOTK",
  );
});
