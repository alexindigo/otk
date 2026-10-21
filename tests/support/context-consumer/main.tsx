// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, For, onCleanup, Show } from "solid-js";
import { render } from "@solidjs/web";
import { type Command, CommandHub } from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";
import {
  browserThemeEnvironment,
  CommandProvider,
  type ContentTarget,
  ContextMenu,
  contextTarget,
  createUiRegistries,
  DialogHost,
  DisplayMenu,
  Message,
  ownedCommand,
  ProjectInbox,
  registerOtkThemes,
  registerTextPart,
  ThemeEngine,
  ThemeRegistry,
  TranscriptContext,
  UiProvider,
} from "@otk/ui";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
const themes = new ThemeRegistry();
registerOtkThemes(themes);
const theme = new ThemeEngine(themes, browserThemeEnvironment(), "otk-dark");
theme.start();
const [contextCount, setContextCount] = createSignal(0);
class ProbeHub extends CommandHub {
  override register<A, R>(command: Command<A, R>): () => void {
    const release = super.register(command);
    if (command.context) setContextCount((value) => value + 1);
    return () => {
      release();
      if (command.context) setContextCount((value) => value - 1);
    };
  }
}
const commands = new ProbeHub(), ui = createUiRegistries();
registerTextPart(ui.parts);
function TranscriptProbe() {
  const [count, setCount] = createSignal(1);
  const [result, setResult] = createSignal("");
  // An independent feature uses the public shared reply vocabulary.
  ownedCommand({ commands }, {
    id: "external.reply.inspect",
    title: "Inspect reply identity",
    category: "Probe",
    context: { kind: "reply", order: 30 },
    run: (_ctx, target: ContentTarget) => setResult(JSON.stringify(target)),
  });
  return (
    <TranscriptContext>
      <button type="button" id="grow-transcript" onClick={() => setCount(40)}>
        Add messages
      </button>
      <output id="context-command-count">{contextCount()}</output>
      <output id="reply-identity">{result()}</output>
      <For
        each={Array.from({ length: count() }, (_, index) => index)}
        keyed={(index) => index}
      >
        {(index) => (
          <Message
            sidecarId="probe-sidecar"
            directory="/probe"
            message={{
              id: `probe-reply-${index()}`,
              sessionID: "probe-session",
              role: "assistant",
              agent: "probe",
              model: { provider: "probe", model: "probe" },
              time: { created: 1, completed: 2 },
              tokens: {
                input: 1,
                output: 1,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              cost: 0,
              interrupted: false,
              parts: [{
                id: `probe-text-${index()}`,
                kind: "text",
                synthetic: false,
                blocks: [{
                  b: "paragraph",
                  inline: [{ i: "text", text: `Reply ${index()}` }],
                }],
              }],
            }}
            prefs={DEFAULT_PREFS}
            permissions={[]}
            paneWidth={1200}
            onOpenChild={() => {}}
            queued={false}
          />
        )}
      </For>
    </TranscriptContext>
  );
}
function ProjectProbe() {
  const [ready, setReady] = createSignal(true);
  return (
    <section id="project-probe">
      <button
        type="button"
        id="disconnect-project"
        onClick={() => setReady(false)}
      >
        Disconnect project
      </button>
      <ProjectInbox
        projects={[{
          directory: "/probe",
          sidecarId: "probe-sidecar",
          label: "Probe",
          order: 0,
          added: true,
          inactive: false,
          lastVisit: 0,
          status: "idle",
          unread: false,
          visitText: "now",
          ageing: 0,
        }]}
        entries={[]}
        servers={[]}
        prefs={DEFAULT_PREFS}
        ready={ready()}
        onOpen={() => {}}
        onInactive={() => Promise.reject(new Error("Project update failed"))}
        onLayout={() => Promise.resolve()}
      />
    </section>
  );
}
ui.dialogs.register({
  id: "context-probe",
  title: "Modal context probe",
  component: () => (
    <>
      <input id="modal-field" aria-label="Modal input" />
      <DisplayMenu
        prefs={DEFAULT_PREFS}
        ready
        error=""
        onSet={() => Promise.resolve()}
      />
    </>
  ),
});
function Consumer() {
  let root!: HTMLElement;
  const [name, setName] = createSignal("original"),
    [result, setResult] = createSignal("");
  const [allowed, setAllowed] = createSignal(true);
  const [menus, setMenus] = createSignal(true);
  const [transcript, setTranscript] = createSignal(false);
  const [projectProbe, setProjectProbe] = createSignal(false);
  ownedCommand({ commands }, {
    id: "probe.inner",
    title: "Inspect code",
    category: "Probe",
    hidden: true,
    context: { kind: "probe.code" },
    run: (_ctx, value: string) => {
      setResult(value);
    },
  });
  ownedCommand({ commands }, {
    id: "probe.outer",
    title: "Inspect reply",
    category: "Probe",
    hidden: true,
    context: {
      kind: "probe.reply",
      title: (value: string) => `Inspect ${value}`,
    },
    run: (_ctx, value: string) => {
      setResult(value);
    },
  });
  ownedCommand({ commands }, {
    id: "probe.close",
    title: "Close reply",
    category: "Probe",
    hidden: true,
    context: { kind: "probe.reply", destructive: true },
    enabled: () => allowed(),
    run: () => {
      setResult("closed");
    },
  });
  for (const kind of ["probe.third", "app"]) {
    onCleanup(
      commands.register({
        id: kind,
        title: kind,
        category: "Probe",
        context: { kind },
        run: () => {
          setResult(kind);
        },
      }),
    );
  }
  return (
    <main
      ref={(el) => {
        root = el;
      }}
    >
      <button type="button" id="rename" onClick={() => setName("changed")}>
        Change target data
      </button>
      <button type="button" id="disable" onClick={() => setAllowed(false)}>
        Remove close action
      </button>
      <button
        type="button"
        id="release-inner"
        onClick={() => commands.unregister("probe.inner")}
      >
        Release code owner
      </button>
      <button
        type="button"
        id="light"
        onClick={() => theme.commit("otk-light")}
      >
        Light
      </button>
      <button type="button" id="dark" onClick={() => theme.commit("otk-dark")}>
        Dark
      </button>
      <button
        id="open-modal"
        type="button"
        onClick={() =>
          void commands.run("dialog.open", { id: "context-probe" })}
      >
        Open modal
      </button>
      <button
        id="remove-modal"
        type="button"
        onClick={() => void commands.run("dialog.close")}
      >
        Remove modal host
      </button>
      <button
        id="toggle-menus"
        type="button"
        onClick={() => setMenus(!menus())}
      >
        Toggle menu owner
      </button>
      <section
        ref={contextTarget(() => ({ kind: "probe.third", data: "third" }))}
      >
        <article
          ref={contextTarget(() => ({ kind: "probe.reply", data: name() }))}
        >
          <button
            id="inner"
            type="button"
            ref={[
              (element: HTMLElement) => {
                element.dataset.composedRef = "yes";
              },
              contextTarget(() => ({
                kind: "probe.code",
                data: `code:${name()}`,
              })),
            ]}
          >
            Nested context target
          </button>
        </article>
      </section>
      <p id="result">{result()}</p>
      <button
        type="button"
        id="mount-transcript"
        onClick={() => setTranscript(true)}
      >
        Mount transcript probe
      </button>
      <Show when={transcript()}>
        <TranscriptProbe />
      </Show>
      <button
        type="button"
        id="mount-project-probe"
        onClick={() => setProjectProbe(true)}
      >
        Mount project probe
      </button>
      <Show when={projectProbe()}>
        <ProjectProbe />
      </Show>
      <img
        id="no-viewer"
        alt="Unregistered viewer probe"
        width="40"
        height="40"
        src='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="orange"/></svg>'
      />
      <Show when={menus()}>
        <ContextMenu root={root} />
      </Show>
      <DialogHost />
    </main>
  );
}
render(() => (
  <UiProvider registries={ui}>
    <CommandProvider commands={commands}>
      <Consumer />
    </CommandProvider>
  </UiProvider>
), document.getElementById("app")!);
