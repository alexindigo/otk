// SPDX-License-Identifier: LGPL-3.0-only
import {
  createEffect,
  createSignal,
  createUniqueId,
  For,
  onSettled,
  Show,
  untrack,
} from "solid-js";
import { Portal } from "@solidjs/web";
import {
  type ActionControl,
  countLabel,
  FeedbackFailure,
  type SidecarConnection,
  type TerminalBox,
  terminalBoxFor,
  type TerminalRun,
} from "@otk/client";
import { useShellPorts } from "../../shell/context.tsx";
import { useSessionPorts } from "../../registries/session.tsx";
import type {
  ComposerDockDefinition,
  DialogRegistry,
  SurfaceRegistry,
} from "../../registries/shell.ts";
import {
  ChevronDownIcon,
  CollapseIcon,
  ExpandIcon,
  PlusIcon,
} from "../../components/ChromeIcons.tsx";
import { TabPanels, TabStrip } from "../../components/Tabs.tsx";
import ActionButton from "../../components/ActionButton.tsx";
import { RunIcon } from "../../components/tools/ToolIcons.tsx";
import PaneState from "../../components/PaneState.tsx";
import Surface from "../../components/surface/Surface.tsx";
import { contextTarget } from "../../components/context-target.ts";
import { ownedCommand, useCommandPorts } from "../../keyboard/context.tsx";
import { solidState } from "../../state/binding.ts";
import {
  createTerminalPanel,
  type TerminalPanelModel,
  terminalTabs,
} from "./model.ts";
import "./terminal.css" with { type: "text" };

interface ExpandedTerminal {
  mount(element: HTMLElement): void;
  release(): void;
  collapse(): void;
}
export function registerTerminalDialog(dialogs: DialogRegistry): void {
  dialogs.register<ExpandedTerminal>({
    id: "terminal",
    title: "Terminal",
    size: "editor",
    ended: (input) => input.collapse(),
    component: (props) => {
      let host!: HTMLDivElement;
      onSettled(() => {
        props.input.mount(host);
        return props.input.release;
      });
      return (
        <div
          class="otk-terminal-dialog-host"
          ref={(element) => {
            host = element;
          }}
        />
      );
    },
  });
}
function Pane(props: { model: TerminalPanelModel; id: string }) {
  const ports = useCommandPorts();
  const command = `terminal.reconnect@${createUniqueId()}`;
  ownedCommand(ports, {
    id: command,
    title: "Reconnect terminal",
    category: "Terminal",
    scope: "control",
    run: () => props.model.select(props.id),
  });
  const reconnect = ports.commands.control(command, undefined, {
    target: { label: "Terminal" },
    shown: () => true,
    unshown: "The terminal could not reconnect.",
    recovery: "Check the connection and try reconnecting",
  });
  let mount!: HTMLDivElement;
  onSettled(() => props.model.mount(props.id, mount));
  return (
    <div class="otk-terminal-pane">
      <Show when={props.model.terminals.state.disconnected.includes(props.id)}>
        <div class="otk-terminal-connection" role="status">
          <span>Terminal disconnected</span>
          <ActionButton action={reconnect}>
            Reconnect
          </ActionButton>
        </div>
      </Show>
      <div
        class="otk-terminal-mount"
        data-terminal={props.id}
        inert={props.model.terminals.state.disconnected.includes(props.id)}
        ref={(element) => {
          mount = element;
        }}
      />
    </div>
  );
}
function PendingRow(props: {
  run: TerminalRun;
  ready(): boolean;
  confirm: ActionControl;
  cancel: ActionControl;
}) {
  let runButton: HTMLElement | undefined;
  createEffect(() => props.ready() && props.run.id, (id) => {
    if (!id) return;
    const frame = requestAnimationFrame(() => {
      runButton?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  });
  const lines = () => props.run.text.split("\n");
  return (
    <div
      class="otk-terminal-pending"
      role="group"
      aria-label="Pasted command"
      data-otk-keyboard="local"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        void props.cancel.run();
      }}
    >
      <span class="otk-terminal-pending-label otk-control-label">Pasted</span>
      <code class="otk-terminal-pending-text" title={props.run.text}>
        {lines()[0]}
      </code>
      <Show when={lines().length > 1}>
        <span class="otk-terminal-pending-label otk-control-label">
          {`+${countLabel(lines().length - 1, "line")}`}
        </span>
      </Show>
      <span class="otk-terminal-pending-space" />
      <ActionButton
        action={props.confirm}
        class="otk-terminal-run"
        ref={(element) => {
          runButton = element;
        }}
      >
        <RunIcon class="otk-terminal-run-icon" />
        <span class="otk-control-label">Run</span>
      </ActionButton>
      <ActionButton action={props.cancel} class="otk-terminal-cancel">
        <span class="otk-control-label">Cancel</span>
      </ActionButton>
    </div>
  );
}

function TerminalContent(
  props: { model: TerminalPanelModel; box: TerminalBox },
) {
  const model = props.model, commands = useCommandPorts();
  ownedCommand(commands, {
    id: "terminal.add-to-prompt",
    title: "Add to prompt",
    category: "Terminal",
    context: { kind: "terminal", order: 10 },
    enabled: () => !!model.state.selection,
    run: () => model.addSelection(),
  });
  const owner = createUniqueId();
  const control = (
    id: string,
    title: string,
    run: () => unknown | Promise<unknown>,
    enabled?: () => boolean,
  ) => {
    const command = `${id}@${owner}`;
    ownedCommand(commands, {
      id: command,
      title,
      category: "Terminal",
      scope: "control",
      enabled,
      run,
    });
    return commands.commands.control(command, undefined, {
      target: { label: title },
      shown: () => true,
      unshown: `${title} did not complete.`,
      recovery: "Check the terminal and try again",
    });
  };
  const add = commands.commands.control("terminal.add-to-prompt", undefined, {
    target: { label: "Add to prompt" },
    shown: () => true,
    unshown: "The terminal selection was not added to the prompt.",
    recovery: "Select the text and try again",
  });
  const create = control("terminal.create", "New terminal", model.create);
  const runPending = control(
    "terminal.run-pending",
    "Run",
    model.confirmRun,
    model.runReady,
  );
  const cancelPending = control(
    "terminal.cancel-pending",
    "Cancel",
    model.cancelRun,
    model.runReady,
  );
  const resize = control(
    "terminal.resize",
    "Resize terminal",
    () =>
      props.box.mode === "expanded" ? props.box.collapse() : props.box.expand(),
  );
  const hide = control(
    "terminal.hide",
    "Hide terminal",
    () => props.box.close(),
  );
  let resizeButton: HTMLElement | undefined;
  const closeID = `terminal.close@${owner}`;
  ownedCommand(commands, {
    id: closeID,
    title: "Close terminal",
    category: "Terminal",
    scope: "control",
    arguments: { type: "string" },
    run: (_context, id: string) => {
      // Move focus off the disappearing X onto a persistent frame control.
      resizeButton?.focus();
      return model.closeIndex(
        model.terminals.state.list.findIndex((item) => item.id === id),
      );
    },
  });
  /** Closes one shell. The box mode is the TerminalBox's alone. */
  const close = (id: string) =>
    commands.commands.control(closeID, id, {
      target: { label: model.title(id) },
      shown: () => !model.terminals.state.list.some((item) => item.id === id),
      unshown: "The terminal did not close.",
      recovery: "Check the terminal and try closing it again",
    });
  const sizeLabel = () =>
    props.box.mode === "expanded" ? "Collapse terminal" : "Expand terminal";
  const tabs = terminalTabs(
    () => model.terminals.state.list,
    model.title,
    (id) => (
      <Show when={model.wants(id)}>
        <Pane model={model} id={id} />
      </Show>
    ),
    (id) => !model.state.closing.includes(id),
  );
  return (
    <section
      class="otk-terminal"
      aria-label="Terminal"
      ref={contextTarget(() => ({ kind: "terminal", data: undefined }))}
    >
      <Surface
        density="panel"
        layout="fill"
        scrollable={false}
        actions={model.pendingRun()
          ? (
            <PendingRow
              run={model.pendingRun()!}
              ready={model.runReady}
              confirm={runPending}
              cancel={cancelPending}
            />
          )
          : undefined}
        title={
          <>
            <Show when={props.box.mode !== "expanded"}>
              <h2 class="otk-control-label">Terminal</h2>
            </Show>
            <TabStrip
              label="Terminals"
              compact
              tabs={tabs()}
              selected={model.selectedIndex()}
              onSelect={model.selectIndex}
              closeAction={close}
            />
          </>
        }
        titleAction={
          <div class="otk-terminal-actions">
            <Show when={model.state.selection}>
              <ActionButton action={add}>
                Add to prompt
              </ActionButton>
            </Show>
            <ActionButton
              action={create}
              class="otk-icon-button"
              label="New terminal"
              title="New terminal"
              busy={model.state.creating}
              onFeedback={(outcome) =>
                model.failure(new FeedbackFailure(outcome.feedback))}
            >
              <PlusIcon />
            </ActionButton>
            <ActionButton
              action={resize}
              class="otk-icon-button"
              label={sizeLabel()}
              title={sizeLabel()}
              ref={(element) => {
                resizeButton = element;
              }}
            >
              <Show
                when={props.box.mode === "expanded"}
                fallback={<ExpandIcon />}
              >
                <CollapseIcon />
              </Show>
            </ActionButton>
            <ActionButton
              action={hide}
              class="otk-icon-button"
              label="Hide terminal"
              title="Hide terminal"
            >
              <ChevronDownIcon />
            </ActionButton>
          </div>
        }
      >
        <Show when={model.state.error || model.terminals.state.error}>
          {(feedback) => <PaneState feedback={feedback() || undefined} />}
        </Show>
        <Show
          when={model.terminals.state.list.length}
          fallback={
            <div class="otk-terminal-empty-body">
              <PaneState>
                <div class="otk-terminal-empty">
                  <Show
                    when={!model.terminals.state.loading &&
                      !model.state.creating}
                    fallback={<p role="status">Opening terminal...</p>}
                  >
                    <p class="otk-terminal-empty-note">
                      No terminals in this session
                    </p>
                    <ActionButton
                      action={create}
                      class="otk-terminal-empty-action"
                      pendingLabel="Opening terminal..."
                    >
                      <PlusIcon />
                      <span class="otk-control-label">New terminal</span>
                    </ActionButton>
                  </Show>
                </div>
              </PaneState>
            </div>
          }
        >
          <TabPanels tabs={tabs()} selected={model.selectedIndex()} />
        </Show>
      </Surface>
    </section>
  );
}
/** One Portal content lifetime; changing its mount moves DOM, not attachments. */
function OpenTerminal(
  props: { connection: SidecarConnection; session: string; box: TerminalBox },
) {
  const shell = useShellPorts(), { commands } = useCommandPorts();
  const [destination, setDestination] = createSignal<HTMLElement>();
  let dock!: HTMLDivElement,
    alive = true,
    dialog: { close(): void } | undefined;
  let focusFrame = 0, pendingPrompt: (() => void) | undefined;
  const focus = () => {
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      focusFrame = 0;
      if (!alive) return;
      // Deliver the selection even if a replacement modal now owns focus.
      if (pendingPrompt) {
        const add = pendingPrompt;
        pendingPrompt = undefined;
        add();
        return;
      }
      const modal = document.querySelector("dialog:modal");
      if (modal && !modal.contains(destination() ?? null)) return;
      model.focus();
    });
  };
  const model = createTerminalPanel(
    props.connection,
    props.session,
    shell.theme,
    (text, label) => {
      if (props.box.mode !== "expanded") {
        shell.addToPrompt(text, label);
        return;
      }
      pendingPrompt = () => shell.addToPrompt(text, label);
      props.box.collapse();
      focus();
    },
    solidState,
    props.box,
  );
  onSettled(() => {
    void model.start();
    createEffect(() => props.box.mode, (mode) => {
      if (mode === "expanded") {
        void commands.run<{ close(): void }>("dialog.open", {
          id: "terminal",
          input: {
            mount: (element: HTMLElement) => {
              if (alive) {
                setDestination(element);
                focus();
              }
            },
            release: () => {
              if (alive) {
                setDestination(dock);
                focus();
              }
            },
            collapse: () => props.box.collapse(),
          } satisfies ExpandedTerminal,
        }).then((handle) => {
          if (alive && props.box.mode === "expanded") dialog = handle;
          else handle.close();
        }).catch(model.failure);
      } else {
        dialog?.close();
        dialog = undefined;
        setDestination(dock);
        focus();
      }
    });
    return () => {
      alive = false;
      cancelAnimationFrame(focusFrame);
      dialog?.close();
      model.dispose();
    };
  });
  return (
    <>
      <div
        class="otk-composer-surface"
        hidden={props.box.mode === "expanded"}
        ref={(element) => {
          dock = element;
          setDestination(element);
        }}
      />
      <Show when={destination()}>
        <Portal mount={destination()!}>
          <TerminalContent model={model} box={props.box} />
        </Portal>
      </Show>
    </>
  );
}
function SessionBox(props: { connection: SidecarConnection; session: string }) {
  const box = terminalBoxFor(props.connection, props.session, solidState);
  return (
    <Show when={box.mode !== "closed"}>
      <OpenTerminal
        connection={props.connection}
        session={props.session}
        box={box}
      />
    </Show>
  );
}
export function registerTerminalDock(
  registry: SurfaceRegistry<ComposerDockDefinition>,
): void {
  registry.register({
    id: "terminal",
    component: () => {
      const shell = useShellPorts(), session = useSessionPorts();
      const target = () => {
        const selected = shell.selection();
        return selected
          ? [{
            connection: shell.connection(selected.sidecarId),
            session: session.sessionID(),
          }]
          : [];
      };
      return (
        <For
          each={target()}
          keyed={(value) => `${value.connection.base.href}/${value.session}`}
        >
          {(selected) => {
            const value = untrack(selected);
            return (
              <SessionBox
                connection={value.connection}
                session={value.session}
              />
            );
          }}
        </For>
      );
    },
  });
}
