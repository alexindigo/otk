// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, createSignal, type Element, For } from "solid-js";
import { render } from "@solidjs/web";
import { CommandHub } from "@otk/client";
import {
  booleanPreference,
  type CapabilityName,
  createPreferences,
  DEFAULT_PREFS,
  type ExternalCall,
} from "@otk/protocol";
import {
  browserThemeEnvironment,
  Code,
  CommandProvider,
  ComposerTakeovers,
  createUiRegistries,
  DialogHost,
  DisplayMenu,
  Docks,
  emptyDraft,
  type LightState,
  Message,
  paintVisualPreferences,
  Prompt,
  registerGenericTool,
  registerOtkThemes,
  registerToolPart,
  registerUnknownPart,
  selection,
  SelectionContent,
  type SessionPorts,
  SessionProvider,
  StatusLight,
  ThemeEngine,
  ThemeRegistry,
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
  ErrorBoundaries,
  SecondaryFailures,
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

function ExternalTool(props: ToolProps): Element {
  return (
    <div data-external-tool>
      <div class="otk-tool-summary">
        External renderer: {(props.call as ExternalCall).summary}
      </div>
      <ToolOutput text={(props.call as ExternalCall).output || ""} limit={3} />
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
      icon: "◇",
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
      async submit(_draft, parts, selection) {
        await ctx.props.onSubmit(
          [...parts, {
            kind: "text",
            text: "external transform",
          }],
          "normal",
          selection,
        );
        return true;
      },
    }),
  });
  const [summary, setSummary] = createSignal("Initial result"),
    [opened, setOpened] = createSignal(""),
    [draft, setDraft] = createSignal(emptyDraft()),
    [submitted, setSubmitted] = createSignal(""),
    [capabilities, setCapabilities] = createSignal<CapabilityName[]>([]),
    [dockClicks, setDockClicks] = createSignal(0);
  const call = (): ExternalCall => ({
    tool: "external",
    callID: "probe",
    name: "external-probe",
    status: "completed",
    time: {},
    awaitingPermission: false,
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
          <For
            each={["blocked", "working", "finished", "idle"] as LightState[]}
          >
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
              submit: (action) => action(),
              history: () => Promise.resolve([]),
              attachments: (parts) => Promise.resolve(parts),
            }}
          >
            <Prompt
              value={draft()}
              onChange={(change) => {
                setDraft(change);
                return draft();
              }}
              connected
              onSubmit={(parts) => {
                setSubmitted(JSON.stringify(parts));
                return Promise.resolve();
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
render(
  new URL(location.href).searchParams.has("secondary-failures")
    ? () => <SecondaryFailures onTheme={(id) => theme.commit(id)} />
    : new URL(location.href).searchParams.has("error-boundaries")
    ? () => <ErrorBoundaries onTheme={(id) => theme.commit(id)} />
    : new URL(location.href).searchParams.has("shared-controls")
    ? () => <SharedControls onTheme={(id) => theme.commit(id)} />
    : Consumer,
  document.getElementById("app")!,
);
