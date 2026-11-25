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
  type SidecarConnection,
  type TerminalBox,
  terminalBoxFor,
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
import Tabs from "../../components/Tabs.tsx";
import ActionButton from "../../components/ActionButton.tsx";
import PaneState from "../../components/PaneState.tsx";
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
    dismiss: (input, close) => {
      input.collapse();
      close();
    },
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
  ) => {
    const command = `${id}@${owner}`;
    ownedCommand(commands, {
      id: command,
      title,
      category: "Terminal",
      scope: "control",
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
  const closeID = `terminal.close@${owner}`;
  ownedCommand(commands, {
    id: closeID,
    title: "Close terminal",
    category: "Terminal",
    scope: "control",
    arguments: { type: "string" },
    run: (_context, id: string) =>
      model.closeIndex(
        model.terminals.state.list.findIndex((item) => item.id === id),
      ),
  });
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
      <Show when={model.state.error || model.terminals.state.error}>
        {(feedback) => <PaneState feedback={feedback() || undefined} />}
      </Show>
      <Show
        when={model.terminals.state.list.length}
        fallback={
          <PaneState>
            <Show
              when={!model.terminals.state.loading && !model.state.creating}
              fallback={<p role="status">Opening terminal...</p>}
            >
              <ActionButton
                action={create}
                pendingLabel="Opening terminal..."
              >
                New terminal
              </ActionButton>
            </Show>
          </PaneState>
        }
      >
        <Tabs
          label="Terminals"
          compact
          tabs={tabs()}
          selected={model.selectedIndex()}
          onSelect={model.selectIndex}
          closeAction={close}
          leading={() => (
            <Show when={props.box.mode !== "expanded"}>
              <h2 class="otk-terminal-heading">Terminal</h2>
            </Show>
          )}
          actions={() => (
            <>
              <Show when={model.state.selection}>
                <ActionButton action={add}>
                  Add to prompt
                </ActionButton>
              </Show>
              <Show when={model.state.creating}>
                <span role="status">Opening terminal...</span>
              </Show>
              <Show when={!model.state.creating}>
                <ActionButton
                  action={create}
                  class="otk-icon-button"
                  label="New terminal"
                  title="New terminal"
                >
                  <PlusIcon />
                </ActionButton>
              </Show>
              <ActionButton
                action={resize}
                class="otk-icon-button"
                label={sizeLabel()}
                title={sizeLabel()}
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
            </>
          )}
        />
      </Show>
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
  let focusFrame = 0, pendingFocus: (() => void) | undefined;
  const focus = () => {
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      focusFrame = 0;
      if (!alive) return;
      const action = pendingFocus ?? model.focus;
      pendingFocus = undefined;
      action();
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
      pendingFocus = () => shell.addToPrompt(text, label);
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
