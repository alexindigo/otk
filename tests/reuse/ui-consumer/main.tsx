// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, createSignal, type Element, For, Show } from "solid-js";
import { render } from "@solidjs/web";
import {
  CommandHub,
  createDrafts,
  createSessionSubmission,
  NotificationHub,
  SidecarConnection,
} from "@otk/client";
import {
  booleanPreference,
  type CapabilityName,
  createPreferences,
  DEFAULT_PREFS,
  type ExternalCall,
} from "@otk/protocol";
import {
  ActionButton,
  browserThemeEnvironment,
  Code,
  CommandProvider,
  ComposerTakeovers,
  createUiRegistries,
  DialogHost,
  DisplayMenu,
  Docks,
  LIGHT_STATES,
  type LightState,
  Message,
  paintVisualPreferences,
  Prompt,
  registerGenericTool,
  registerOtkThemes,
  registerToastChannel,
  registerToolPart,
  registerUnknownPart,
  ScrollRegion,
  selection,
  SelectionContent,
  type SessionPorts,
  SessionProvider,
  solidState,
  StatusLight,
  ThemeEngine,
  ThemeRegistry,
  Toasts,
  ToolLine,
  ToolOutput,
  type ToolProps,
  UiProvider,
  useSessionPorts,
} from "@otk/ui";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import SharedControls, {
  deliverFixturePrompt,
  ErrorBoundaries,
  Indicators,
  InteractionFailures,
  LayoutControls,
  LayoutTabs,
  LazyPreview,
  MetadataPolicy,
  PickerLifetime,
  SecondaryFailures,
  SourceOwnership,
} from "./shared-controls.tsx";

declare module "@otk/protocol" {
  interface CapabilityContracts {
    external: { probe(): void };
  }
  interface RpcMethods {
    "consumer.echo": { params: { value: string }; result: string };
  }
  interface Preferences {
    "consumer.compact": boolean;
  }
  interface PartKinds {
    "consumer.card": { kind: "consumer.card"; id: string; text: string };
  }
}

const themes = new ThemeRegistry();
registerOtkThemes(themes);
const theme = new ThemeEngine(themes, browserThemeEnvironment(), "otk-dark");
theme.start();
const server = new URL(location.href).searchParams.get("server");
if (server) {
  const connection = new SidecarConnection(server, {
    status() {},
    frame(frame) {
      if (frame.t === "prefs") {
        theme.commit(frame.prefs.theme, frame.prefs.systemLightTheme);
      }
    },
  });
  await connection.connect();
}

function ExternalTool(props: ToolProps): Element {
  return (
    <div data-external-tool>
      <div class="otk-tool-summary">
        External renderer: {(props.call as ExternalCall).summary}
      </div>
      <ToolOutput text={(props.call as ExternalCall).output || ""} />
      <button
        type="button"
        data-open
        onClick={() => props.onOpenChild(props.call.childSessionID!)}
      >
        Open result
      </button>
    </div>
  );
}
/** Every outcome an action control can end in, through the shared owner. */
function ActionOutcomes(props: { commands: CommandHub }): Element {
  const register = (
    id: string,
    availability: () =>
      | { available: true }
      | { available: false; reason: string; hidden?: true },
    run: () => unknown,
  ) =>
    props.commands.register({
      id,
      title: id,
      category: "Consumer",
      availability,
      run,
    });
  register("Open unobserved", () => ({ available: true }), () => {});
  register("Open failing", () => ({ available: true }), () => {
    throw new Error("fixture rejection");
  });
  register(
    "Open closed",
    () => ({ available: false, reason: "Server offline" }),
    () => {},
  );
  register(
    "Open self",
    () => ({ available: false, reason: "Already open", hidden: true }),
    () => {},
  );
  const control = (id: string) =>
    props.commands.control(id, undefined, {
      target: { label: id },
      shown: () => false,
      unshown: "The fixture view did not open.",
      recovery: "Choose the fixture again",
    });
  return (
    <section data-action-outcomes>
      <For
        each={[
          "Open unobserved",
          "Open failing",
          "Open closed",
          "Open self",
          "Open late",
        ]}
      >
        {(id) => (
          <div data-action={id}>
            <ActionButton action={control(id)}>{id}</ActionButton>
          </div>
        )}
      </For>
      <button
        type="button"
        onClick={() =>
          register("Open late", () => ({ available: true }), () => {})}
      >
        Install action owner
      </button>
    </section>
  );
}
function ActionToasts(): Element {
  const [current, setCurrent] = createSignal("current");
  const [viewing, setViewing] = createSignal(true);
  let holdView = false;
  const commands = new CommandHub(() => ({
    sidecar: "local",
    session: current(),
    viewing: viewing(),
  }));
  for (const id of ["session.open", "session.preview"]) {
    commands.register({
      id,
      title: "Open session",
      category: "Test",
      arguments: { type: "object" },
      availability: (context, target?: { sessionID: string }) =>
        id === "session.preview" && context.viewing !== false &&
          target?.sessionID === current()
          ? { available: false, reason: "Already open", hidden: true }
          : { available: true },
      run: (_context, target: { sessionID: string }) => {
        if (target.sessionID === "refused") return false;
        setCurrent(target.sessionID);
        if (!holdView) setViewing(true);
      },
    });
  }
  const hub = new NotificationHub(
    () => ({ channels: ["toast"] }),
    (id, args) => commands.run(id, args),
    () => {},
  );
  const toast = registerToastChannel(hub);
  for (const id of ["current", "refused", "other"]) {
    hub.publish({
      id,
      kind: "error",
      title: `Target ${id}`,
      dismissOnView: false,
      actions: [{
        label: "Open session",
        command: "session.open",
        args: { sidecarId: "local", sessionID: id },
      }],
    });
  }
  return (
    <CommandProvider commands={commands}>
      <Show when={viewing()} fallback={<p data-toast-settings>Settings</p>}>
        <output data-toast-view>{current()}</output>
      </Show>
      <button
        type="button"
        onClick={() => {
          holdView = true;
          setViewing(false);
        }}
      >
        Hide session view
      </button>
      <button
        type="button"
        onClick={() => {
          holdView = false;
        }}
      >
        Allow session view
      </button>
      <Toasts model={toast.model} onMore={() => {}} />
    </CommandProvider>
  );
}
function Consumer(): Element {
  const commands = new CommandHub();
  const preferenceRegistry = createPreferences();
  preferenceRegistry.register({
    key: "consumer.compact",
    default: false,
    validate: booleanPreference,
    label: "Consumer compact layout",
    display: { order: 100, control: { kind: "toggle" } },
  });
  const [prefs, setPrefs] = createSignal(preferenceRegistry.defaults());
  const [lightEvent, setLightEvent] = createSignal(0);
  createEffect(() => prefs(), (value) => paintVisualPreferences(value));
  const ui = createUiRegistries(), isolated = createUiRegistries();
  registerGenericTool(ui.tools);
  registerGenericTool(isolated.tools);
  registerToolPart(ui.parts);
  registerUnknownPart(ui.parts);
  ui.tools.register(
    "external-probe",
    ExternalTool,
    (call) => ({
      icon: () => (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 3 9 9-9 9-9-9Z" fill="none" stroke="currentColor" />
        </svg>
      ),
      verb: "Inspect",
      target: "external target",
      summary: call.summary,
    }),
  );
  ui.parts.register(
    "agent",
    (props) => <p data-external-part>Injected part: {props.part.id}</p>,
  );
  ui.parts.registerTyped(
    "consumer.card",
    (props) => <p data-typed-part>Feature part: {props.part.text}</p>,
  );
  ui.docks.register({
    id: "external",
    capability: "external",
    render: (inputs) => inputs.external,
  });
  ui.dialogs.register<{ text: string }>({
    id: "external",
    title: "External dialog",
    component: (props) => (
      <section data-external-dialog>
        {props.input.text}
        <button type="button" data-close-dialog onClick={props.close}>
          Close external dialog
        </button>
      </section>
    ),
  });
  ui.takeovers.register({
    id: "external",
    capability: "external",
    component: () => {
      const session = useSessionPorts();
      return (
        <button
          type="button"
          data-external-takeover
          onClick={() =>
            void session.rpc("consumer.echo", { value: "external" }).then(
              setOpened,
            )}
        >
          External takeover
        </button>
      );
    },
  });
  ui.prompt.register({
    id: "external-transform",
    create: (ctx) => ({
      actions: () => (
        <button
          type="button"
          data-inject
          onClick={() =>
            ctx.change((draft) => ({
              ...draft,
              input: "Injected draft",
              agent: "external-agent",
            }))}
        >
          Inject draft
        </button>
      ),
      async submit(_draft, parts, selection, capture) {
        await ctx.props.onSubmit(
          [...parts, {
            kind: "text",
            text: "external transform",
          }],
          "normal",
          selection,
          capture,
        );
        return true;
      },
    }),
  });
  const [summary, setSummary] = createSignal("Initial result"),
    [opened, setOpened] = createSignal(""),
    [submitted, setSubmitted] = createSignal(""),
    [capabilities, setCapabilities] = createSignal<CapabilityName[]>([]),
    [dockClicks, setDockClicks] = createSignal(0);
  const drafts = createDrafts(solidState);
  const submit = createSessionSubmission({
    sessionID: "session",
    directory: () => Promise.resolve(""),
    inbox: { act: (_dir, action) => action() },
    tabs: () => ({ send: (_id, action) => action() }),
    delivery: { send: deliverFixturePrompt },
  });
  const call = (): ExternalCall => ({
    tool: "external",
    callID: "probe",
    name: "external-probe",
    status: "completed",
    time: {},
    summary: summary(),
    output: "Reusable output",
    childSessionID: "child-probe",
  });
  return (
    <CommandProvider commands={commands}>
      <UiProvider registries={ui}>
        <section
          data-visual-gallery
          style={{
            padding: "16px",
            display: "flex",
            "align-items": "center",
            gap: "16px",
          }}
        >
          <For each={Object.keys(LIGHT_STATES) as LightState[]}>
            {(state) => <StatusLight state={state} event={lightEvent()} />}
          </For>
          <StatusLight state="working" small event={lightEvent()} />
          <button
            type="button"
            data-light-event
            onClick={() => setLightEvent((value) => value + 1)}
          >
            New event
          </button>
          <For each={[0, 1, 2, 3]}>
            {(age) => (
              <span class={`otk-age-${age}`} data-age={age}>Project {age}</span>
            )}
          </For>
        </section>
        <section id="registered" style={{ padding: "1rem" }}>
          <h1>Independent UI registration</h1>
          <ActionOutcomes commands={commands} />
          <button
            type="button"
            data-light
            onClick={() => theme.commit("otk-light")}
          >
            Light
          </button>
          <button
            type="button"
            data-dark
            onClick={() => theme.commit("otk-dark")}
          >
            Dark
          </button>
          <button
            type="button"
            data-stone
            onClick={() => theme.commit("otk-light-stone")}
          >
            Stone
          </button>
          <section data-selection-gallery>
            <button
              type="button"
              data-otk-selection="vertical"
              {...selection({ kind: "selected", selected: true })}
            >
              <SelectionContent>Vertical selected</SelectionContent>
            </button>
            <button
              type="button"
              data-otk-selection="vertical"
              {...selection({ kind: "selected", selected: false })}
            >
              <SelectionContent>Vertical idle</SelectionContent>
            </button>
            <button
              type="button"
              data-otk-selection="horizontal"
              {...selection({ kind: "current", selected: true })}
            >
              <SelectionContent>Horizontal current</SelectionContent>
            </button>
            <button
              type="button"
              data-otk-selection="horizontal"
              {...selection({ kind: "current", selected: false })}
            >
              <SelectionContent>Horizontal idle</SelectionContent>
            </button>
            <button type="button" class="otk-pill">Quiet action</button>
            <button type="button" class="otk-pill otk-primary">
              Primary action
            </button>
            <button
              type="button"
              class="otk-icon-button"
              aria-label="Icon action"
            >
              +
            </button>
            <button
              type="button"
              class="otk-send-button otk-primary"
              aria-label="Send"
            >
              ↑
            </button>
          </section>
          <div data-library-code>
            <Code text="const externalResult: number = 7;" lang="ts" />
          </div>
          <ToolLine
            call={call()}
            prefs={DEFAULT_PREFS}
            paneWidth={800}
            genericOutput
            waiting={false}
            onOpenChild={setOpened}
          />
          <Message
            message={{
              id: "reply",
              sessionID: "session",
              role: "user",
              time: { created: 0 },
              parts: [
                { id: "tool", kind: "tool", call: call() },
                { id: "agent", kind: "external", name: "agent" },
                { id: "card", kind: "consumer.card", text: summary() },
                { id: "future", kind: "external", name: "future.card" },
              ],
            }}
            prefs={DEFAULT_PREFS}
            permissions={[]}
            paneWidth={800}
            queued={false}
            onOpenChild={setOpened}
          />
          <button
            type="button"
            data-update
            onClick={() => setSummary("Updated result")}
          >
            Update result
          </button>
          <output id="opened">{opened()}</output>
          <SessionProvider
            ports={{
              supports: (capability) =>
                capability === "prompt" || capabilities().includes(capability),
              rpc:
                (() => Promise.resolve("typed external reply")) as SessionPorts[
                  "rpc"
                ],
              sessionID: () => "session",
              directory: () => Promise.resolve(""),
              entry: () => undefined,
              permissions: () => [],
              questions: () => [],
              prefs,
              dirty: () => {},
              act: (action) => action(),
              submit,
              history: () => Promise.resolve([]),
              attachments: (parts) => Promise.resolve(parts),
            }}
          >
            <Prompt
              value={drafts.get("session")}
              onChange={drafts.writer("session")}
              captureSend={(draft) => drafts.captureSend("session", draft)}
              connected
              onSubmit={async (parts, _mode, _selection, capture) => {
                await submit(
                  (_options, dispatch, messageID) => {
                    dispatch();
                    setSubmitted(JSON.stringify(parts));
                    return Promise.resolve({ messageID, state: "accepted" });
                  },
                  "composer",
                  undefined,
                  capture,
                );
              }}
              onAbort={async () => {}}
            />
            <ComposerTakeovers />
          </SessionProvider>
          <button
            type="button"
            data-open-dialog
            onClick={() =>
              void commands.run("dialog.open", {
                id: "external",
                input: { text: "Feature-owned dialog" },
              })}
          >
            Open external dialog
          </button>
          <DialogHost />
          <output id="submitted">{submitted()}</output>
          <button
            type="button"
            data-capability
            onClick={() => setCapabilities(["external"])}
          >
            Enable external dock
          </button>
          <Docks
            capabilities={capabilities()}
            inputs={{
              get external() {
                return (
                  <button
                    data-external-dock
                    type="button"
                    onClick={() => setDockClicks((count) => count + 1)}
                  >
                    Injected dock {dockClicks()}
                  </button>
                );
              },
            }}
          />
          <DisplayMenu
            registry={preferenceRegistry}
            prefs={prefs()}
            ready
            error=""
            onSet={(key, value) => {
              setPrefs((previous) => ({ ...previous, [key]: value }));
              return Promise.resolve();
            }}
          />
          <output data-consumer-preference>
            {String(prefs()["consumer.compact"])}
          </output>
        </section>
      </UiProvider>
      <UiProvider registries={isolated}>
        <section id="isolated" style={{ padding: "1rem" }}>
          <h2>Separate consumer fallback</h2>
          <ToolLine
            call={call()}
            prefs={DEFAULT_PREFS}
            paneWidth={800}
            genericOutput
            waiting={false}
            onOpenChild={setOpened}
          />
        </section>
      </UiProvider>
    </CommandProvider>
  );
}
function ScrollbarProbe(): Element {
  const [hidden, setHidden] = createSignal(false);
  let mounts = 0;
  function Content() {
    mounts++;
    return (
      <div
        data-scroll-content
        data-mounts={mounts}
        style={{ height: "1000px", width: "600px" }}
      >
        Scrollable source
      </div>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setHidden(!hidden())}>
        Toggle region
      </button>
      <div
        style={{
          height: "200px",
          width: "300px",
          display: "grid",
          "grid-template-rows": "minmax(0, 1fr)",
        }}
      >
        <ScrollRegion
          role="region"
          aria-label="Scroll probe"
          tabindex={0}
          hidden={hidden()}
        >
          <Content />
        </ScrollRegion>
      </div>
    </>
  );
}
render(
  new URL(location.href).searchParams.has("action-toasts")
    ? ActionToasts
    : new URL(location.href).searchParams.has("scrollbars")
    ? ScrollbarProbe
    : new URL(location.href).searchParams.has("source-ownership")
    ? SourceOwnership
    : new URL(location.href).searchParams.has("picker-lifetime")
    ? PickerLifetime
    : new URL(location.href).searchParams.has("lazy-preview")
    ? LazyPreview
    : new URL(location.href).searchParams.has("layout-tabs")
    ? () => <LayoutTabs onTheme={(id) => theme.commit(id)} />
    : new URL(location.href).searchParams.has("layout-controls")
    ? () => <LayoutControls onTheme={(id) => theme.commit(id)} />
    : new URL(location.href).searchParams.has("indicators")
    ? () => <Indicators onTheme={(id) => theme.commit(id)} />
    : new URL(location.href).searchParams.has("interaction-failures")
    ? () => <InteractionFailures onTheme={(id) => theme.commit(id)} />
    : new URL(location.href).searchParams.has("secondary-failures")
    ? () => <SecondaryFailures onTheme={(id) => theme.commit(id)} />
    : new URL(location.href).searchParams.has("error-boundaries")
    ? () => <ErrorBoundaries onTheme={(id) => theme.commit(id)} />
    : new URL(location.href).searchParams.has("shared-controls")
    ? () => <SharedControls onTheme={(id) => theme.commit(id)} />
    : new URL(location.href).searchParams.has("metadata-policy")
    ? MetadataPolicy
    : Consumer,
  document.getElementById("app")!,
);
