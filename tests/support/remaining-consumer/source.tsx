// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, Show } from "solid-js";
import { render } from "@solidjs/web";
import { CommandHub } from "@otk/client";
import { type AssistantMessage, DEFAULT_PREFS } from "@otk/protocol";
import {
  CommandProvider,
  createUiRegistries,
  Message,
  TranscriptContext,
  UiProvider,
} from "@otk/ui";

export function mountSourceProbe() {
  const ui = createUiRegistries(), commands = new CommandHub();
  let reads = 0, stringifiedBytes = 0, bodies = 0, registrations = 0;
  const register = commands.register.bind(commands);
  commands.register = (command) => {
    const release = register(command);
    registrations++;
    let active = true;
    return () => {
      if (active) {
        active = false;
        registrations--;
        release();
      }
    };
  };
  const base = "Provider-only complete source ".repeat(2000);
  const workID = "work", time = { start: 1, end: 2 };
  const message = (rank: number): AssistantMessage => ({
    id: "reply",
    sessionID: "tstv1-source",
    role: "assistant",
    agent: "build",
    model: { provider: "external", model: "probe" },
    time: { created: 1, completed: 2 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    parts: [{
      id: workID,
      kind: "external",
      name: "source.work",
      data: `${base}${rank}`,
    }],
  });
  const [current, setCurrent] = createSignal(message(0));
  const [mounted, setMounted] = createSignal(true);
  ui.parts.register("source.work", (props) => {
    bodies++;
    return <pre data-source-body>{props.part.data}</pre>;
  }, (part) => ({
    work: time,
    copyable: true,
    get text() {
      reads++;
      const value = JSON.stringify({ source: part.data });
      stringifiedBytes += value.length;
      return value;
    },
  }));
  // D74: this standalone consumer supplies one fixed Work run. Only the
  // registered part's source changes; no Work model or panel is under test.
  const run = {
    key: workID,
    lane: "action" as const,
    label: "Provider work",
    partIDs: [workID],
    live: false,
    failed: false,
    ...time,
  };
  const work = {
    runs: {
      runs: [run],
      segments: [{
        run: run.key,
        lane: run.lane,
        failed: run.failed,
        live: run.live,
        weightMs: 1,
        title: run.label,
      }],
      actions: 1,
      failed: [],
      bookkeeping: [],
      trailingThoughts: [],
      summary: "Work log: 1 action",
      runOf: (partID: string) => partID === workID ? workID : undefined,
    },
    shown: false,
    action: () => ({
      availability: () => ({ available: true }) as const,
      subscribe: () => () => {},
      run: () => Promise.reject(new Error("The Work log must stay closed")),
    }),
    onFeedback() {},
  };
  Object.assign(globalThis, {
    sourceProbe: {
      mount: setMounted,
      reset() {
        reads = 0;
        stringifiedBytes = 0;
        bodies = 0;
      },
      facts() {
        return { reads, stringifiedBytes, bodies, commands: registrations };
      },
      expected: () => {
        const part = current().parts[0];
        return JSON.stringify({
          source: part.kind === "external" ? part.data : "",
        });
      },
      async run() {
        for (let rank = 1; rank <= 1000; rank++) {
          setCurrent(message(rank));
          await new Promise(requestAnimationFrame);
        }
      },
    },
  });
  return render(() => (
    <CommandProvider commands={commands}>
      <UiProvider registries={ui}>
        <Show when={mounted()}>
          <TranscriptContext>
            <Message
              message={current()}
              work={work}
              prefs={DEFAULT_PREFS}
              permissions={[]}
              queued={false}
              onOpenChild={() => {}}
            />
          </TranscriptContext>
        </Show>
      </UiProvider>
    </CommandProvider>
  ), document.body);
}
