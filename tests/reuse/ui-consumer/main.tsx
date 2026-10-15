// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, type Element } from "solid-js";
import { render } from "@solidjs/web";
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
  createUiRegistries,
  DisplayMenu,
  Docks,
  emptyDraft,
  Message,
  Prompt,
  registerGenericTool,
  registerOtkThemes,
  registerToolPart,
  registerUnknownPart,
  ThemeEngine,
  ThemeRegistry,
  ToolLine,
  ToolOutput,
  type ToolProps,
  UiProvider,
} from "@otk/ui";
import "@fontsource/ibm-plex-mono/400.css";

declare module "@otk/protocol" {
  interface CapabilityContracts {
    external: { probe(): void };
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
  const preferenceRegistry = createPreferences();
  preferenceRegistry.register({
    key: "consumer.compact",
    default: false,
    validate: booleanPreference,
    label: "Consumer compact layout",
    display: { order: 100, control: { kind: "toggle" } },
  });
  const [prefs, setPrefs] = createSignal(preferenceRegistry.defaults());
  const ui = createUiRegistries(), isolated = createUiRegistries();
  registerGenericTool(ui.tools);
  registerGenericTool(isolated.tools);
  registerToolPart(ui.parts);
  registerUnknownPart(ui.parts);
  ui.tools.register("external-probe", ExternalTool);
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
  ui.prompt.register({
    id: "external-transform",
    create: (ctx) => ({
      actions: () => (
        <button
          type="button"
          data-inject
          onClick={() =>
            ctx.change((draft) => ({ ...draft, input: "Injected draft" }))}
        >
          Inject draft
        </button>
      ),
      async submit(_draft, parts) {
        await ctx.props.onSubmit([...parts, {
          kind: "text",
          text: "external transform",
        }], "normal");
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
    <>
      <UiProvider registries={ui}>
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
          <Prompt
            value={draft()}
            onChange={(change) => {
              setDraft(change);
              return draft();
            }}
            connected
            pasteSummary
            onSubmit={(parts) => {
              setSubmitted(JSON.stringify(parts));
              return Promise.resolve();
            }}
            onFind={() => Promise.resolve([])}
            onMentions={() =>
              Promise.resolve({
                files: [],
                agents: [],
                resources: [],
                frecency: [],
                directory: "",
              })}
            onBump={async () => {}}
            onCommands={() => Promise.resolve([])}
            onCommand={async () => {}}
            onNew={async () => {}}
            onHistory={() => Promise.resolve([])}
            onAbort={async () => {}}
          />
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
    </>
  );
}
render(Consumer, document.getElementById("app")!);
