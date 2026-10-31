// SPDX-License-Identifier: LGPL-3.0-only
import {
  createEffect,
  createSignal,
  type Element,
  onCleanup,
  Show,
} from "solid-js";
import {
  CommandHub,
  createInbox,
  createSessionRename,
  createSessionSubmission,
  createTabs,
  createTaskActions,
  duration,
  exactCount,
  type MergedEntry,
  NotificationHub,
  relativeTime,
  type SidecarState,
} from "@otk/client";
import {
  booleanPreference,
  createPreferences,
  DEFAULT_PREFS,
  errorMessage,
  type InboxSnapshot,
  type PreferenceKey,
  type Preferences,
  type ShellLayout,
  type ToolBase,
} from "@otk/protocol";
import {
  ActivityIndicator,
  CommandProvider,
  ConnectionLight,
  createUiRegistries,
  DialogHost,
  Diff,
  DisplayMenu,
  emptyDraft,
  Form,
  FormInput,
  ListPicker,
  Login,
  Message,
  NotificationSettings,
  paintVisualPreferences,
  Palette,
  PaneState,
  PathProvider,
  ProjectInbox,
  ProjectTabs,
  Prompt,
  QuestionDock,
  registerBadgeChannel,
  registerEditTool,
  registerGenericTool,
  registerPatchTool,
  registerTaskDialogs,
  registerTextPart,
  registerToolPart,
  registerUnknownPart,
  RightPanel,
  SessionProvider,
  Setup,
  Sidebar,
  solidState,
  ToolLine,
  ToolOutput,
  ToolPath,
  TranscriptContext,
  UiProvider,
  VisualSettings,
} from "@otk/ui";

export function LayoutTabs(props: { onTheme(id: string): void }): Element {
  const commands = new CommandHub();
  const entries: MergedEntry[] = Array.from({ length: 12 }, (_, i) => ({
    id: `tstv1-independent-${i}`,
    sidecarId: "independent",
    directory: "/independent",
    projectID: "independent",
    title: `Independent session ${i} with a long title`,
    timeCreated: 1,
    timeUpdated: 1,
    archived: false,
    status: "idle",
    digest: { state: "digesting", revision: 0, turns: {} },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  }));
  const task = {
    id: "independent-task",
    directory: "/independent",
    name: "Independent task",
    order: 0,
    sessions: entries.map((entry) => entry.id),
  };
  const inbox: InboxSnapshot = {
    projects: [],
    tasks: [task],
    seen: {},
    finishes: {},
    pathTemplates: [],
  };
  const model = createTabs(() => Promise.resolve(task), solidState);
  model.update({ directory: "/independent", entries, inbox });
  model.select({ kind: "task", id: task.id }, entries[6].id);
  let settle: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const rename = createSessionRename({
    factory: solidState,
    rename: () => {
      settle = Promise.withResolvers<void>();
      return settle.promise;
    },
  });
  onCleanup(() => model.stop());
  const actions = createTaskActions({
    call: () => Promise.reject(new Error("Unexpected task mutation")),
  }, "/independent");
  return (
    <CommandProvider commands={commands}>
      <button
        type="button"
        data-theme-dark
        onClick={() => props.onTheme("otk-dark")}
      >
        Dark
      </button>
      <button
        type="button"
        data-theme-light
        onClick={() => props.onTheme("otk-light")}
      >
        Linen
      </button>
      <button
        type="button"
        data-edit-chip
        onClick={() =>
          rename.start({
            sidecarId: "independent",
            sessionID: entries[4].id,
            title: entries[4].title,
          }, "chip")}
      >
        Edit another chip
      </button>
      <button
        type="button"
        data-reject-chip
        onClick={() => settle?.reject(new Error("Refused rename"))}
      >
        Reject rename
      </button>
      <ProjectTabs
        project={{ sidecarId: "independent", directory: "/independent" }}
        model={model}
        entries={entries}
        inbox={inbox}
        rename={rename}
        ready
        onOpen={() => true}
        onEmpty={() => true}
        onCreateSession={() => Promise.resolve()}
        actions={actions}
      />
    </CommandProvider>
  );
}

/** Deliberately independent composition: only public content/callback ports. */
export function LayoutControls(props: { onTheme(id: string): void }): Element {
  const commands = new CommandHub(), ui = createUiRegistries();
  registerTaskDialogs(ui.dialogs);
  const [diffWidth, setDiffWidth] = createSignal(800);
  const [mode, setMode] = createSignal("setup"),
    [payload, setPayload] = createSignal(""),
    [choice, setChoice] = createSignal("First choice");
  let settle: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const save = async (value: unknown) => {
    setPayload(JSON.stringify(value));
    settle = Promise.withResolvers<void>();
    await settle.promise;
  };
  const open = () =>
    commands.run("dialog.open", {
      id: "task-name",
      input: { save: (name: string) => save({ name }) },
    });
  return (
    <CommandProvider commands={commands}>
      <UiProvider registries={ui}>
        <header class="otk-control-row">
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
          <button type="button" data-setup onClick={() => setMode("setup")}>
            Setup
          </button>
          <button type="button" data-login onClick={() => setMode("login")}>
            Login
          </button>
          <button type="button" data-task onClick={() => void open()}>
            New task
          </button>
          <button
            type="button"
            data-reject
            onClick={() => settle?.reject(new Error("Private failure"))}
          >
            Reject
          </button>
          <button type="button" data-accept onClick={() => settle?.resolve()}>
            Accept
          </button>
          <output data-payload>{payload()}</output>
          <button
            type="button"
            data-wide-diff
            onClick={() => setDiffWidth(diffWidth() === 800 ? 1300 : 800)}
          >
            Resize independent diff
          </button>
        </header>
        <main
          data-auth-pane
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            height: "650px",
            padding: "24px",
          }}
        >
          <Show
            when={mode() === "setup"}
            fallback={<Login label="Independent OTK server" onLogin={save} />}
          >
            <Setup onSetup={save} />
          </Show>
        </main>
        <section data-picker style={{ width: "220px" }}>
          <ListPicker
            label="Independent choice"
            triggerLabel={`Independent choice: ${choice()}`}
            trigger={choice()}
            groups={[{
              key: "choices",
              items: [{
                key: "first",
                value: "First choice",
                label: "First choice",
              }, {
                key: "second",
                value: "A longer second choice",
                label: "A longer second choice",
              }],
            }]}
            onPick={setChoice}
            focusAfterPick={() => {}}
          />
        </section>
        <section data-independent-form>
          <Form
            title="Independent form"
            submitLabel="Save independent value"
            onSubmit={(data) => save({ value: data.get("value") })}
          >
            <label>
              Value<FormInput name="value" value="Original value" />
            </label>
          </Form>
        </section>
        <section
          data-independent-pane
          style={{ display: "grid", height: "180px" }}
        >
          <PaneState
            feedback={{ kind: "info", text: "Independent empty state" }}
          />
        </section>
        <DialogHost />
        <section data-independent-diff style={{ width: `${diffWidth()}px` }}>
          <Diff
            file={{
              path: "/independent/file.ts",
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
            }}
            style="auto"
            wrap={false}
            paneWidth={1920}
          />
        </section>
      </UiProvider>
    </CommandProvider>
  );
}

export function MetadataPolicy(): Element {
  const commands = new CommandHub();
  const hub = new NotificationHub(
    () => ({ channels: ["badge"] }),
    async () => {},
    () => {},
  );
  const release = registerBadgeChannel(hub);
  hub.publish({
    id: "attention",
    kind: "permission",
    title: "Needs attention",
    sessionRef: { sidecar: "external", session: "tstv1-external" },
    actions: [],
  });
  onCleanup(() => {
    hub.stop();
    release();
  });
  return (
    <CommandProvider commands={commands}>
      <main>
        <h1>Independent metadata consumer</h1>
        <output data-format>
          {exactCount(1234567)} {duration(1234)} {relativeTime(0, 90_000_000)}
        </output>
        <PathProvider paths={{ style: "win32", separator: "\\" }}>
          <div data-path>
            <ToolPath
              path="c:\\project\\src\\file.ts"
              directory="C:\\Project"
            />
          </div>
        </PathProvider>
        <ToolOutput
          text={Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`).join(
            "\n",
          )}
        />
      </main>
    </CommandProvider>
  );
}

export function Indicators(props: { onTheme(id: string): void }): Element {
  const healthy: SidecarState = {
    id: "probe",
    label: "Probe",
    baseUrl: "",
    status: "connected",
    harness: "connected",
    capabilities: [],
  };
  const [server, setServer] = createSignal<SidecarState | undefined>(healthy);
  const commands = new CommandHub(), ui = createUiRegistries();
  return (
    <CommandProvider commands={commands}>
      <UiProvider registries={ui}>
        <div class="otk-control-row">
          <button
            type="button"
            data-case="connected"
            onClick={() => setServer(healthy)}
          >
            Connected
          </button>
          <button
            type="button"
            data-case="connecting"
            onClick={() => setServer({ ...healthy, status: "connecting" })}
          >
            Connecting
          </button>
          <button
            type="button"
            data-case="reconnecting"
            onClick={() => setServer({ ...healthy, harness: "reconnecting" })}
          >
            Reconnecting
          </button>
          <button
            type="button"
            data-case="disconnected"
            onClick={() => setServer(undefined)}
          >
            Disconnected
          </button>
          <button
            type="button"
            data-case="error"
            onClick={() => setServer({ ...healthy, error: "Transport failed" })}
          >
            Error
          </button>
          <button
            type="button"
            data-theme="otk-dark"
            onClick={() => props.onTheme("otk-dark")}
          >
            Dark
          </button>
          <button
            type="button"
            data-theme="otk-light"
            onClick={() => props.onTheme("otk-light")}
          >
            Linen
          </button>
          <button
            type="button"
            data-theme="otk-light-stone"
            onClick={() => props.onTheme("otk-light-stone")}
          >
            Stone
          </button>
        </div>
        <section data-independent-connection>
          <ConnectionLight connection={server()} />
        </section>
        <section data-independent-activity>
          <ActivityIndicator small />
        </section>
        <Sidebar
          sidecars={server() ? [server()!] : []}
          entries={[]}
          onOpen={() => {}}
          onCreate={() => {}}
          onSettings={() => {}}
        />
      </UiProvider>
    </CommandProvider>
  );
}

declare module "@otk/protocol" {
  interface PartKinds {
    "consumer.unregistered": {
      kind: "consumer.unregistered";
      id: string;
      label: "Extension label must not render";
    };
  }
  interface ToolKinds {
    "consumer.unregistered": ToolBase & {
      tool: "consumer.unregistered";
      outputTruncated: "collision";
    };
  }
  interface Preferences {
    "consumer.appearance": boolean;
    "consumer.notification": boolean;
  }
}

export function InteractionFailures(
  props: { onTheme(id: string): void },
): Element {
  const ui = createUiRegistries(), commands = new CommandHub();
  registerGenericTool(ui.tools);
  registerUnknownPart(ui.parts);
  registerTextPart(ui.parts);
  registerToolPart(ui.parts);
  const [draft, setDraft] = createSignal(emptyDraft()),
    [kind, setKind] = createSignal("async");
  const reject = (source: string) => {
    if (kind() === "sync") throw new Error(`Synchronous ${source} refusal`);
    return Promise.reject(new Error(`Asynchronous ${source} refusal`));
  };
  ui.prompt.register({
    id: "refusing-port",
    create: () => ({
      paste(event) {
        event.preventDefault();
        return reject("paste");
      },
      drop: () => reject("drop"),
    }),
  });
  return (
    <CommandProvider commands={commands}>
      <UiProvider registries={ui}>
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
            <h1>Interaction feedback and open fallback contracts</h1>
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
            <button type="button" data-sync onClick={() => setKind("sync")}>
              Synchronous refusal
            </button>
            <button type="button" data-async onClick={() => setKind("async")}>
              Asynchronous refusal
            </button>
          </header>
          <TranscriptContext>
            <Message
              sidecarId="probe"
              message={{
                id: "probe",
                sessionID: "probe",
                role: "assistant",
                time: { created: 1, completed: 2 },
                agent: "Consumer",
                model: { provider: "Independent", model: "Fixture" },
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                cost: 0,
                interrupted: false,
                parts: [
                  {
                    kind: "text",
                    id: "text",
                    synthetic: false,
                    blocks: [{
                      b: "paragraph",
                      inline: [{
                        i: "text",
                        text:
                          "Keep this reply available after a clipboard refusal.",
                      }],
                    }],
                  },
                  {
                    kind: "consumer.unregistered",
                    id: "part",
                    label: "Extension label must not render",
                  },
                  {
                    kind: "tool",
                    id: "tool",
                    call: {
                      tool: "consumer.unregistered",
                      callID: "tool",
                      status: "completed",
                      time: {},
                      awaitingPermission: false,
                      output:
                        "Common output survives an unregistered extension.",
                      outputTruncated: "collision",
                    },
                  },
                ],
              }}
              prefs={{ ...DEFAULT_PREFS, genericToolOutput: true }}
              permissions={[]}
              paneWidth={736}
              queued={false}
              onOpenChild={() => {}}
            />
          </TranscriptContext>
          <SessionProvider
            ports={{
              supports: () => true,
              rpc: () => Promise.reject(new Error("Unexpected RPC")),
              sessionID: () => "probe",
              directory: () => Promise.resolve("/project"),
              entry: () => undefined,
              permissions: () => [],
              questions: () => [],
              prefs: () => DEFAULT_PREFS,
              dirty() {},
              act: (action) => action(),
              submit: (action) => action(),
              history: () => Promise.resolve([]),
              attachments: (parts) => Promise.resolve(parts),
            }}
          >
            <Prompt
              value={draft()}
              connected
              busy={false}
              onChange={(update) => {
                let next = draft();
                setDraft((current) =>
                  next = typeof update === "function" ? update(current) : update
                );
                return next;
              }}
              onSubmit={() => Promise.resolve()}
              onAbort={() => Promise.resolve()}
            />
          </SessionProvider>
        </main>
      </UiProvider>
    </CommandProvider>
  );
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

export function SecondaryFailures(
  props: { onTheme(id: string): void },
): Element {
  const commands = new CommandHub(), ui = createUiRegistries();
  const [draft, setDraft] = createSignal(emptyDraft()),
    [sent, setSent] = createSignal(0),
    [diagnostic, setDiagnostic] = createSignal("");
  const inbox = createInbox(
    {
      call: () => Promise.reject(new Error("Visit storage unavailable")),
    },
    undefined,
    (error) => setDiagnostic(errorMessage(error)),
  );
  const submit = createSessionSubmission({
    sessionID: "probe",
    directory: () => Promise.resolve("/project"),
    inbox,
    tabs: () => ({ send: (_id, action) => action() }),
  });
  return (
    <CommandProvider commands={commands}>
      <UiProvider registries={ui}>
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
            <h1>Successful action, separate bookkeeping</h1>
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
          <section>
            <h2>Submitted actions</h2>
            <output data-sent>{sent()}</output>
          </section>
          <Show when={diagnostic()}>
            <p role="alert" data-bookkeeping>
              Project visit could not be recorded: {diagnostic()}
            </p>
          </Show>
          <SessionProvider
            ports={{
              supports: (capability) => capability === "prompt",
              sessionID: () => "probe",
              directory: () => Promise.resolve("/project"),
              entry: () => undefined,
              permissions: () => [],
              questions: () => [],
              prefs: () => DEFAULT_PREFS,
              dirty: () => {},
              act: (action) => inbox.act("/project", action),
              submit,
              history: () => Promise.resolve([]),
              attachments: (parts) => Promise.resolve(parts),
              rpc: () => Promise.reject(new Error("Unexpected RPC")),
            }}
          >
            <Prompt
              value={draft()}
              onChange={(change) => {
                setDraft(change);
                return draft();
              }}
              connected
              onSubmit={() =>
                submit(() => {
                  setSent((value) => value + 1);
                  return Promise.resolve();
                })}
              onAbort={() => Promise.resolve()}
            />
          </SessionProvider>
        </main>
      </UiProvider>
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
