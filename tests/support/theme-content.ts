// SPDX-License-Identifier: LGPL-3.0-only
import { mapTool, type RawPart } from "@otk/harness-opencode-v1";
import type { AssistantMessage, Message, Part } from "@otk/protocol";
import { themeResults } from "./theme-results.ts";

/** Fixed, public external-backend contracts. These are not native journeys. */
export async function themeContent(directory: string) {
  const sessionID = "tstv1-theme-content";
  const text = (id: string, value: string): Part => ({
    id,
    kind: "text",
    synthetic: false,
    blocks: [{ b: "paragraph", inline: [{ i: "text", text: value }] }],
  });
  const reply = (
    id: string,
    parts: Part[],
    extra: Partial<AssistantMessage> = {},
  ): AssistantMessage => ({
    id,
    sessionID,
    role: "assistant",
    replyTo: "prompt",
    agent: "build",
    model: { provider: "fake2", model: "scripted" },
    time: { created: 2000, completed: 6000 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    parts,
    ...extra,
  });
  const user: Message = {
    id: "prompt",
    sessionID,
    role: "user",
    time: { created: 1 },
    parts: [text("prompt-text", "Review the fixed source")],
  };
  const recorded = async (family: "tools" | "files"): Promise<Message[]> => {
    const source = await Deno.readTextFile(
      new URL(
        `../fixtures/opencode1/m3-${
          family === "files" ? "file" : "basic"
        }-tools.json`,
        import.meta.url,
      ),
    );
    const raw = JSON.parse(
      source.replace(
        /\/home\/tester\/otk\/\.test-state\/oc-[^/]+\/project/g,
        directory,
      ),
    ) as RawPart[];
    if (family === "tools") {
      raw.find((p) => p.tool === "echo_fixture")!.state!.output = Array.from({
        length: 15,
      }, (_, i) => `Generic line ${i + 1}`).join("\n");
    }
    if (family === "files") {
      const edit = raw.find((p) => p.tool === "edit")!;
      Object.assign(
        edit,
        JSON.parse(
          JSON.stringify(edit).replaceAll(
            "newValue",
            "newValue_" + "x".repeat(200),
          ),
        ),
      );
    }
    return [
      user,
      ...raw.map((part, i) =>
        reply(`reply-${i}`, [{
          id: part.id,
          kind: "tool",
          call: mapTool(part),
        }], { replyTo: `prompt-${i}` })
      ),
    ];
  };
  const base = {
    status: "completed" as const,
    awaitingPermission: false,
    time: { start: 1000, end: 2000 },
  };
  const forms = (answered: boolean): Message[] => [
    user,
    reply("forms", [
      {
        id: "todo",
        kind: "tool",
        call: {
          ...base,
          callID: "todo",
          tool: "todo",
          items: (["pending", "in_progress", "completed", "cancelled"] as const)
            .map((status) => ({
              content: `${status} item`,
              status,
              priority: "medium",
            })),
        },
      },
      {
        id: "question",
        kind: "tool",
        call: {
          ...base,
          callID: "question",
          tool: "question",
          status: answered ? "completed" : "running",
          questions: [{
            text: "Which rendering?",
            options: [{ label: "Typed", description: "OTK shapes" }, {
              label: "Raw",
              description: "Harness types",
            }],
            ...(answered ? { answer: ["Typed"] } : {}),
          }],
        },
      },
    ]),
  ];
  const prose: Message[] = [
    user,
    reply("reading", [
      text(
        "prose",
        "A readable reply stays in a centred lane with source and diffs aligned to its shared edges. "
          .repeat(12),
      ),
      {
        id: "code",
        kind: "text",
        synthetic: false,
        blocks: [{
          b: "code",
          lang: "ts",
          text: "const readingColumn = true;",
        }],
      },
      {
        id: "reasoning",
        kind: "reasoning",
        time: { start: 2000, end: 6000 },
        blocks: [{
          b: "paragraph",
          inline: [{ i: "text", text: "Reasoning remains available." }],
        }],
      },
      {
        id: "work",
        kind: "tool",
        call: {
          ...base,
          callID: "work",
          tool: "bash",
          command: "pwd",
          description: "Project directory",
          output: directory,
        },
      },
      {
        id: "helper",
        kind: "tool",
        call: {
          ...base,
          callID: "helper",
          tool: "task",
          description: "Inspect the result",
          childSessionID: "tstv1-child",
          progress: { state: "unavailable", revision: 0, toolCount: null },
        },
      },
      { id: "step", kind: "step", phase: "finish" },
      { id: "meta", kind: "meta" },
    ]),
  ];
  const stream = (done = false, interrupted = false): Message[] => [
    reply("earlier", [text("earlier-text", "An earlier reply is finished.")], {
      replyTo: "earlier-prompt",
    }),
    reply("reply", [
      text(
        "text",
        "The response is still arriving. More content follows here.",
      ),
    ], {
      time: { created: 7000, ...(done ? { completed: 9000 } : {}) },
      interrupted,
    }),
  ];
  const chips: Message[] = [{
    ...user,
    parts: [
      text("text", "Historical parts"),
      {
        id: "file",
        kind: "file",
        mime: "text/plain",
        name: "fixture.txt",
        url: "file:///fixture.txt",
      },
      { id: "agent", kind: "agent", name: "general" },
      { id: "compaction", kind: "compaction" },
    ],
  }];
  const queued = (
    done: boolean,
  ): Message[] => [
    user,
    reply("first", [text("first-text", "First reply continues.")], {
      agentColor: "#6bacff",
      time: { created: 2, ...(done ? { completed: 6000 } : {}) },
    }),
    {
      ...user,
      id: "queued",
      time: { created: 7000 },
      parts: [text("queued-text", "Queued prompt")],
    },
    ...(done
      ? [
        reply("last", [text("last-text", "Queued prompt answered.")], {
          replyTo: "queued",
          agentColor: "#6bacff",
        }),
      ]
      : []),
  ];
  return {
    sessionID,
    collections: {
      ...themeResults(directory, sessionID),
      tools: await recorded("tools"),
      files: await recorded("files"),
      "question-pending": forms(false),
      "question-answered": forms(true),
      reading: prose,
      chips,
      queued: queued(false),
      answered: queued(true),
      streaming: stream(),
      complete: stream(true),
      interrupted: stream(true, true),
      permission: [user],
      "permission-read": [user],
      "permission-edit": [user],
      question: [user],
      revert: [user],
      fork: [user],
      unreported: [user],
      recovery: prose,
      retry: prose,
      disclosures: [
        user,
        reply("disclosure", [{
          id: "read",
          kind: "tool",
          call: {
            ...base,
            callID: "disclosure",
            tool: "read",
            path: directory + "/folded.ts",
            loaded: [],
            outputContent: {
              kind: "file",
              text: "const foldedSecret = 42;",
              lang: "ts",
              startLine: 1,
              endLine: 1,
              totalLines: 1,
              truncated: false,
            },
          },
        }]),
      ],
    } satisfies Record<string, Message[]>,
  };
}
