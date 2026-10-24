// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, createSignal, type Element, Show } from "solid-js";
import { CommandHub } from "@otk/client";
import {
  booleanPreference,
  createPreferences,
  DEFAULT_PREFS,
  type PreferenceKey,
  type Preferences,
  type ShellLayout,
} from "@otk/protocol";
import {
  CommandProvider,
  createUiRegistries,
  DisplayMenu,
  emptyDraft,
  Login,
  NotificationSettings,
  paintVisualPreferences,
  Palette,
  ProjectInbox,
  Prompt,
  QuestionDock,
  registerEditTool,
  registerPatchTool,
  RightPanel,
  SessionProvider,
  ToolLine,
  UiProvider,
  VisualSettings,
} from "@otk/ui";

declare module "@otk/protocol" {
  interface Preferences {
    "consumer.appearance": boolean;
    "consumer.notification": boolean;
  }
}

export function ErrorBoundaries(props: { onTheme(id: string): void }): Element {
  const [kind, setKind] = createSignal("null");
  const reject = () =>
    Promise.reject(kind() === "null" ? null : "Injected failure");
  const commands = new CommandHub();
  commands.register({
    id: "consumer.failure",
    title: "Run failing action",
    category: "Consumer",
    run: reject,
  });
  return (
    <CommandProvider commands={commands}>
      <main
        style={{
          padding: "24px",
          "max-width": "736px",
          margin: "0 auto",
          display: "grid",
          gap: "24px",
        }}
      >
        <header>
          <h1>Consumer failure feedback</h1>
          <button type="button" data-null onClick={() => setKind("null")}>
            Null rejection
          </button>
          <button type="button" data-string onClick={() => setKind("string")}>
            String rejection
          </button>
          <button
            type="button"
            data-dark
            onClick={() => props.onTheme("otk-dark")}
          >
            Dark
          </button>
          <button
            type="button"
            data-light
            onClick={() => props.onTheme("otk-light")}
          >
            Linen
          </button>
        </header>
        <section data-login>
          <Login label="Independent consumer" onLogin={reject} />
        </section>
        <section data-preferences>
          <VisualSettings prefs={DEFAULT_PREFS} ready onSet={reject} />
        </section>
        <section data-palette>
          <h2>Commands</h2>
          <Palette
            onClose={() => {
              throw new Error("A failed command must not close");
            }}
          />
        </section>
      </main>
    </CommandProvider>
  );
}

/** An alternate application supplies its own registry, authoritative state and save ports. */
export default function SharedControls(
  props: { onTheme(id: string): void },
): Element {
  const registry = createPreferences(),
    commands = new CommandHub(),
    ui = createUiRegistries();
  registry.register(
    Object.assign({
      key: "consumer.appearance" as const,
      default: false,
      validate: booleanPreference,
      label: "External appearance",
    }, {
      settings: {
        group: "appearance",
        order: 100,
        control: { kind: "toggle" as const },
      },
    }),
  );
  registry.register(
    Object.assign({
      key: "consumer.notification" as const,
      default: false,
      validate: booleanPreference,
      label: "External notification",
    }, {
      settings: {
        group: "notifications",
        order: 100,
        control: { kind: "toggle" as const },
      },
    }),
  );
  const [prefs, setPrefs] = createSignal(registry.defaults()),
    [ready, setReady] = createSignal(true),
    [draft, setDraft] = createSignal(emptyDraft()),
    [mounted, setMounted] = createSignal(true);
  const [calls, setCalls] = createSignal(0),
    [pending, setPending] = createSignal(0);
  createEffect(() => prefs(), (value) => paintVisualPreferences(value));
  const settlements: ((accept: boolean) => void)[] = [];
  const save = (apply: () => void) => {
    setCalls((calls) => calls + 1);
    setPending((pending) => pending + 1);
    return new Promise<void>((resolve, reject) => {
      settlements.push((accept) => {
        setPending((pending) => pending - 1);
        if (accept) {
          apply();
          resolve();
        } else reject(new Error("Save refused"));
      });
    });
  };
  const onSet = (key: PreferenceKey, value: Preferences[PreferenceKey]) =>
    save(() => setPrefs({ ...prefs(), [key]: value }));
  const onLayout = (patch: Partial<ShellLayout>) =>
    save(() =>
      setPrefs({
        ...prefs(),
        shellLayout: { ...prefs().shellLayout, ...patch },
      })
    );
  ui.panels.register({
    id: "probe",
    title: "Probe panel",
    icon: "P",
    component: () => <p>Independent panel content</p>,
  });
  ui.prompt.register({
    id: "completion-probe",
    create: (ctx) => ({
      source: {
        trigger: (input) =>
          input === "@" ? { start: 0, end: 1, query: "" } : undefined,
        options: () =>
          Promise.resolve([{
            id: "one",
            label: "First option",
            description: "First description",
          }, {
            id: "two",
            label: "Second option",
            description: "Second description",
          }]),
        select: (_token, option) => {
          ctx.change((value) => ({ ...value, input: option.label }));
        },
      },
    }),
  });
  registerEditTool(ui.tools);
  registerPatchTool(ui.tools);
  const request = {
    id: "shared-question",
    sessionID: "probe",
    questions: [{
      header: "Output",
      text: "Describe the output",
      options: [{ label: "Default", description: "Standard output" }],
      custom: true,
      multiple: false,
    }],
  };
  return (
    <CommandProvider commands={commands}>
      <UiProvider registries={ui}>
        <nav
          aria-label="Fixture controls"
          style={{ display: "flex", gap: "8px" }}
        >
          <button
            type="button"
            data-dark
            onClick={() => props.onTheme("otk-dark")}
          >
            Dark
          </button>
          <button
            type="button"
            data-light
            onClick={() => props.onTheme("otk-light")}
          >
            Linen
          </button>
          <button type="button" data-ready onClick={() => setReady(!ready())}>
            Ready {String(ready())}
          </button>
          <button
            type="button"
            data-accept
            onClick={() => settlements.shift()?.(true)}
          >
            Accept save
          </button>
          <button
            type="button"
            data-reject
            onClick={() => settlements.shift()?.(false)}
          >
            Reject save
          </button>
          <button
            type="button"
            data-broadcast
            onClick={() =>
              setPrefs({
                ...prefs(),
                reducedColors: true,
                "notify.sound": true,
                diffStyle: "split",
              })}
          >
            Broadcast
          </button>
          <button
            type="button"
            data-remount
            onClick={() => setMounted(!mounted())}
          >
            Toggle question mount
          </button>
          <output data-calls>{calls()}</output>
          <output data-pending>{pending()}</output>
        </nav>
        <div style={{ display: "flex", gap: "16px", padding: "16px" }}>
          <section data-display>
            <DisplayMenu
              prefs={prefs()}
              ready={ready()}
              error=""
              registry={registry}
              onSet={onSet}
            />
          </section>
          <VisualSettings
            prefs={prefs()}
            ready={ready()}
            onSet={onSet}
            {...{ registry }}
          />
          <NotificationSettings
            prefs={prefs()}
            ready={ready()}
            onSet={onSet}
            {...{ registry }}
            browser={{ state: { status: "denied" }, subscribe: () => () => {} }}
          />
        </div>
        <div style={{ display: "flex", height: "220px" }}>
          <ProjectInbox
            projects={[]}
            entries={[]}
            servers={[]}
            prefs={prefs()}
            ready={ready()}
            onOpen={() => {}}
            onInactive={() => Promise.resolve()}
            onLayout={onLayout}
          />
          <main style={{ flex: "1" }}>Independent layout</main>
          <RightPanel
            layout={{ ...prefs().shellLayout, rightCollapsed: false }}
            ready={ready()}
            supports={() => true}
            onLayout={onLayout}
          />
        </div>
        <SessionProvider
          ports={{
            supports: () => true,
            sessionID: () => "probe",
            directory: () => Promise.resolve("/project"),
            entry: () => undefined,
            permissions: () => [],
            questions: () => [],
            prefs,
            dirty: () => {},
            act: (action) => action(),
            submit: (action) => action(),
            history: () => Promise.resolve([]),
            attachments: (parts) => Promise.resolve(parts),
            rpc: () => Promise.reject(new Error("Unexpected RPC")),
          }}
        >
          <Prompt
            value={draft()}
            onChange={(update) => {
              setDraft(update);
              return draft();
            }}
            connected
            onSubmit={() => Promise.resolve()}
            onAbort={() => Promise.resolve()}
          />
          <Show when={mounted()}>
            <QuestionDock
              request={request}
              onDirty={() => {}}
              onReply={() => Promise.resolve()}
            />
          </Show>
        </SessionProvider>
        <div data-diffs>
          {(["edit", "patch"] as const).map((tool) => (
            <ToolLine
              call={{
                callID: tool,
                status: "completed",
                time: {},
                awaitingPermission: false,
                ...(tool === "edit"
                  ? {
                    tool: "edit" as const,
                    path: "/project/a.ts",
                    diagnostics: [],
                  }
                  : { tool: "patch" as const }),
                files: [{
                  path: "/project/a.ts",
                  status: "modified",
                  additions: 1,
                  deletions: 1,
                  hunks: [{
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 1,
                    lines: [{ kind: "del", text: "old", oldNo: 1 }, {
                      kind: "add",
                      text: "new",
                      newNo: 1,
                    }],
                  }],
                }],
              }}
              prefs={prefs()}
              paneWidth={800}
              directory="/project"
              genericOutput={false}
              waiting={false}
              onOpenChild={() => {}}
            />
          ))}
        </div>
      </UiProvider>
    </CommandProvider>
  );
}
