// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onCleanup, Show } from "solid-js";
import { render } from "@solidjs/web";
import {
  type BodyTarget,
  CommandHub,
  createDrafts,
  createIndex,
  createTranscripts,
  type ScopeRef,
  SidecarConnection,
  type TranscriptOwner,
} from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";
import {
  browserThemeEnvironment,
  Code,
  CommandProvider,
  createUiRegistries,
  registerEditTool,
  registerGenericTool,
  registerOtkThemes,
  registerTaskTool,
  registerTextPart,
  registerToolPart,
  type SessionPorts,
  SessionProvider,
  SessionView,
  solidState,
  ThemeEngine,
  ThemeRegistry,
  UiProvider,
} from "@otk/ui";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./style.css" with { type: "text" };
import { createScaleProbe } from "./probe.ts";

const input = new URL(location.href).searchParams;
const a: BodyTarget = { sidecarId: "heap", sessionID: input.get("a")! };
const b: BodyTarget = { sidecarId: "heap", sessionID: input.get("b")! };
const directory = input.get("directory")!, oldest = input.get("oldest")!;
const themes = new ThemeRegistry();
registerOtkThemes(themes);
const theme = new ThemeEngine(
  themes,
  browserThemeEnvironment(),
  input.get("theme") ?? "otk-dark",
);
const stopTheme = theme.start();
const ui = createUiRegistries();
registerTextPart(ui.parts);
registerToolPart(ui.parts);
registerGenericTool(ui.tools);
registerTaskTool(ui.tools);
registerEditTool(ui.tools);
const commands = new CommandHub();

function Consumer() {
  const index = createIndex(solidState), drafts = createDrafts(solidState);
  const [selected, setSelected] = createSignal<
    { target: BodyTarget; owner: TranscriptOwner }
  >();
  const [error, setError] = createSignal("");
  const [subscriptionClock, setSubscriptionClock] = createSignal(0);
  const [interactionClock, setInteractionClock] = createSignal(0);
  const subscriptions = new Set<string>();
  let now = 0, serial = 0, started = false;
  const timers = new Map<number, { at: number; run(): void }>();
  const scope = (target: BodyTarget): ScopeRef => ({
    sidecarId: "heap",
    directory,
    taskID: target.sessionID,
  });
  const connection = new SidecarConnection(
    input.get("api") ?? location.origin,
    {
      status() {},
      frame(frame) {
        let accepted = true;
        if (
          frame.t === "index.snapshot" || frame.t === "index.patch"
        ) accepted = index.receive("heap", frame);
        if (probe) {
          probe.receive(frame, () => owner.receive("heap", frame, accepted));
        } else owner.receive("heap", frame, accepted);
        if (!started && index.get("heap", b.sessionID) && connection.messages) {
          started = true;
          open(b);
        }
      },
    },
  );
  const send = connection.send.bind(connection);
  connection.send = (frame) => {
    if (frame.t === "subscribe" || frame.t === "unsubscribe") {
      if (frame.t === "subscribe") subscriptions.add(frame.sessionID);
      else subscriptions.delete(frame.sessionID);
      setSubscriptionClock((value) => value + 1);
    }
    send(frame);
  };
  const owner = createTranscripts({
    connection: () => connection,
    entry: (server, id) => index.get(server, id),
    changes: (server) => index.changes(server),
    factory: solidState,
    clock: {
      now: () => now,
      set(run, delay) {
        const id = ++serial;
        timers.set(id, { at: now + delay, run });
        return id;
      },
      clear(id) {
        timers.delete(id as number);
      },
    },
  });
  const probe = input.has("probe")
    ? createScaleProbe({
      target: a,
      owner: () => owner.get(a),
      pane: () =>
        document.querySelector<HTMLElement>(".heap-view .otk-messages"),
    })
    : undefined;
  const open = (target: BodyTarget) => {
    connection.view({
      directory,
      selected: target.sessionID,
      crumbs: [],
      rows: [a.sessionID, b.sessionID],
    });
    owner.setDemand({
      scope: scope(target),
      sessions: [target],
      selected: target,
    });
    setSelected({ target, owner: owner.get(target)! });
    if (target.sessionID === a.sessionID) probe?.install(owner.get(target)!);
    // This explicit independent preview keeps B's public Code consumer alive
    // through every A load/cool cycle, using B's same canonical body resource.
    owner.preload(b, scope(b), [b]);
  };
  const cool = () => {
    now += connection.messages!.coolms + 1;
    for (;;) {
      const due = [...timers].filter(([, timer]) =>
        timer.at <= now
      ).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) {
        break;
      }
      timers.delete(due[0]);
      due[1].run();
    }
  };
  const code = () => {
    selected();
    const state = owner.get(b)?.state;
    for (const id of state?.messageIDs.toReversed() ?? []) {
      for (const part of state!.messagesByID[id].parts) {
        if (part.kind !== "text") {
          continue;
        }
        const block = part.blocks.find((block) => block.b === "code");
        if (block?.b === "code") return block.text;
      }
    }
    return undefined;
  };
  const aState = () => {
    selected();
    return owner.get(a)?.state;
  };
  const subscribed = () => {
    subscriptionClock();
    return subscriptions.has(a.sessionID);
  };
  const remembered = () => {
    selected();
    interactionClock();
    return owner.get(a)?.interaction.disclosure("heap-choice", "fixture")
      .value() ?? false;
  };
  connection.view({
    directory,
    selected: b.sessionID,
    crumbs: [],
    rows: [a.sessionID, b.sessionID],
  });
  void connection.connect().catch((error) => setError(String(error)));
  onCleanup(() => {
    probe?.stop();
    owner.stop();
    connection.stop();
    stopTheme();
  });
  return (
    <>
      <nav class="heap-controls">
        <Show when={probe}>
          <button
            type="button"
            id="heap-arm-reserve"
            onClick={() => probe!.armReserve()}
          >
            Measure reserve
          </button>
          <button
            type="button"
            id="heap-arm-stream"
            onClick={() => probe!.armStream()}
          >
            Measure streaming
          </button>
          <button
            type="button"
            id="heap-stop-probe"
            onClick={() => probe!.stop()}
          >
            Finish measurement
          </button>
        </Show>
        <button type="button" id="heap-open-a" onClick={() => open(a)}>
          Open large session
        </button>
        <button type="button" id="heap-open-b" onClick={() => open(b)}>
          Open code session
        </button>
        <Show when={selected()?.target.sessionID === a.sessionID}>
          <button
            type="button"
            id="heap-load-all"
            onClick={() =>
              void owner.get(a)!.ensure(oldest).catch((error) =>
                setError(String(error))
              )}
          >
            Acquire full history
          </button>
          <button
            type="button"
            id="heap-choice"
            onClick={() => {
              const choice = owner.get(a)!.interaction.disclosure(
                "heap-choice",
                "fixture",
              );
              choice.set(!choice.value());
              setInteractionClock((value) => value + 1);
            }}
          >
            Remember disclosure
          </button>
        </Show>
        <Show when={selected()?.target.sessionID === b.sessionID}>
          <button type="button" id="heap-cool" onClick={cool}>
            Advance cooling clock
          </button>
        </Show>
      </nav>
      <output
        id="heap-state"
        data-a-count={aState()?.messageIDs.length ?? 0}
        data-a-replies={aState()?.replyIDs.length ?? 0}
        data-a-temperature={aState()?.temperature ?? "cold"}
        data-a-busy={String(index.get("heap", a.sessionID)?.status === "busy")}
        data-a-subscribed={String(subscribed())}
        data-a-metadata={String(!!index.get("heap", a.sessionID))}
        data-choice={String(remembered())}
        data-loading={String(selected()?.owner.state.pageLoading ?? false)}
      >
        {error()}
      </output>
      <aside class="heap-preview">
        <Show when={!!code()}>
          <Code text={code()!} lang="ts" />
        </Show>
      </aside>
      <main class="heap-view">
        <Show when={selected()?.owner} keyed>
          {(current) => {
            const target = selected()!.target;
            const state = () => current.state;
            const key = `heap/${target.sessionID}`;
            const ports: SessionPorts = {
              supports: () => false,
              rpc: (method, params, signal) =>
                connection.rpc.call(method, params, signal),
              sessionID: () => target.sessionID,
              directory: () => Promise.resolve(directory),
              entry: (id) => index.get("heap", id),
              permissions: () => state().content.permissions,
              questions: () => state().content.questions,
              prefs: () => DEFAULT_PREFS,
              dirty() {},
              act: (action) => action(),
              submit: (action) => action(),
              history: () => Promise.resolve([]),
              attachments: (parts) => Promise.resolve(parts),
            };
            return (
              <SessionProvider ports={ports}>
                <SessionView
                  sidecarId="heap"
                  info={state().info}
                  label="Heap consumer"
                  transcript={current}
                  latestPrompt={state().latestPrompt}
                  entry={index.get("heap", target.sessionID)}
                  loading={state().loading}
                  paging={state().paging}
                  exhausted={state().exhausted}
                  continuity={state().continuity}
                  error={state().error}
                  draft={drafts.get(key)}
                  onDraft={(change) => {
                    owner.interact(scope(target));
                    return drafts.writer(key)(change);
                  }}
                  connected
                  prefs={DEFAULT_PREFS}
                  permissions={[]}
                  siblings={[]}
                  child={false}
                  revert={null}
                  busy={false}
                  onOpenChild={() => {}}
                  onOlder={() => current.older()}
                  onRetry={() => current.refetch()}
                  onPrompt={() => Promise.resolve()}
                  onAbort={() => Promise.resolve()}
                />
              </SessionProvider>
            );
          }}
        </Show>
      </main>
    </>
  );
}
render(() => (
  <UiProvider registries={ui}>
    <CommandProvider commands={commands}>
      <Consumer />
    </CommandProvider>
  </UiProvider>
), document.getElementById("app")!);
