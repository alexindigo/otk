// SPDX-License-Identifier: LGPL-3.0-only
import {
  createState,
  type FailureValue,
  failureValue,
  FeedbackFailure,
  SessionTerminals,
  type SidecarConnection,
  type StateFactory,
  TERMINAL_RUN_LABEL,
  type TerminalAttachment,
  type TerminalBox,
  type TerminalRunTarget,
  TERMINALS_UNAVAILABLE,
} from "@otk/client";
import type { TerminalInfo } from "@otk/protocol";
import type { ThemeEngine } from "../../theme/engine.ts";
import {
  createTerminalRenderer,
  type TerminalRenderer,
} from "../../terminal/adapter.ts";
import { terminalSocketFor } from "../../terminal/connections.ts";

interface Pane {
  alive: boolean;
  renderer?: TerminalRenderer;
  attachment?: TerminalAttachment;
  detachRun?: () => void;
}

function runTarget(id: string, pane: Pane): TerminalRunTarget {
  return {
    terminalID: id,
    bracketedPaste: () => pane.renderer!.bracketedPaste(),
    paste: (text) => pane.renderer!.paste(text),
    submit: () => pane.renderer!.submit(),
    erase: (count) => pane.renderer!.erase(count),
  };
}
export function terminalPrompt(text: string, title: string) {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) {
    length = Math.max(length, match[0].length + 1);
  }
  const fence = "`".repeat(length);
  return {
    text: fence + "text\n" + text + "\n" + fence,
    label: ("Terminal: " + title).slice(0, 40),
  };
}

/** Session/lifecycle intents; the component only renders this state and slots. */
export function createTerminalPanel(
  connection: SidecarConnection,
  sessionID: string,
  theme: ThemeEngine,
  add: (text: string, label: string) => void,
  factory: StateFactory = createState,
  box?: TerminalBox,
  rendererFactory = createTerminalRenderer,
) {
  const terminals = new SessionTerminals(
    terminalSocketFor(connection),
    connection,
    sessionID,
    factory,
  );
  const store = factory({
    preparing: "",
    selection: "",
    creating: false,
    closing: [] as string[],
    error: "" as FailureValue,
  });
  const panes = new Map<string, Pane>();
  let alive = true,
    started = false,
    wasLoading = false,
    intent = "",
    observed: string | undefined,
    creating: Promise<void> | undefined;
  const fail = (cause: unknown, actionLabel: string) => {
    if (!alive) return;
    const failure = failureValue(cause, { actionLabel, target: { sessionID } });
    if (!failure) return;
    const code = failure.failure?.value.code;
    if (code === "terminal-unavailable" || code === "method") {
      box?.markUnavailable(TERMINALS_UNAVAILABLE);
    }
    store.update((state) => {
      state.error = failure;
    });
    const error = new FeedbackFailure(failure);
    box?.runs.fail(error);
    return error;
  };
  // Input is admitted only after the mux restores the shell's active modes.
  const drain = () => {
    if (
      !alive || !started || !box?.runs.waiting || box.mode === "closed" ||
      box.unavailable || creating ||
      terminals.state.loading || terminals.state.error
    ) return;
    const selected = terminals.state.list.find((item) =>
      item.id === terminals.state.selected
    );
    if (!selected || selected.status !== "running") {
      void create();
      return;
    }
    const pane = panes.get(selected.id);
    if (
      !pane?.alive || !pane.attachment || !pane.renderer ||
      !box.runs.ready(selected.id) ||
      terminals.state.disconnected.includes(selected.id)
    ) return;
    try {
      box.runs.deliver(selected.id);
      if (!box.runs.pending) pane.renderer.focus();
    } catch (cause) {
      fail(cause, TERMINAL_RUN_LABEL);
    }
  };
  const title = (id: string) =>
    terminals.state.list.find((item) => item.id === id)?.title ||
    `Terminal ${id}`;
  const display = () => {
    for (const [id, pane] of panes) {
      pane.renderer?.visible(id === terminals.state.selected);
    }
    store.update((state) => {
      state.selection =
        panes.get(terminals.state.selected ?? "")?.renderer?.selection() ?? "";
    });
  };
  // A retained renderer can remain attached while offscreen. The write port
  // exists only while its live channel can actually accept bytes.
  const bindRunTarget = (id: string, pane: Pane) => {
    if (!box) return;
    const { list, disconnected } = terminals.state;
    if (
      pane.alive && pane.renderer && pane.attachment?.retained &&
      !disconnected.includes(id) &&
      list.some((item) => item.id === id && item.status === "running")
    ) {
      pane.detachRun ??= box.runs.attach(runTarget(id, pane));
    } else {
      pane.detachRun?.();
      pane.detachRun = undefined;
    }
  };
  const activate = (id: string, pane: Pane) => {
    if (!alive || !pane.alive || !pane.renderer || intent !== id) return;
    pane.attachment = terminals.show(id, pane.renderer.sink);
    bindRunTarget(id, pane);
    intent = "";
    store.update((state) => {
      state.preparing = "";
    });
    display();
    pane.renderer.focus();
    drain();
  };
  const select = (id: string) => {
    if (!alive || !terminals.state.list.some((item) => item.id === id)) return;
    intent = id;
    store.update((state) => {
      state.preparing = id;
      state.selection = "";
    });
    const pane = panes.get(id);
    if (pane) activate(id, pane);
  };
  const unlisten = terminals.subscribe(() => {
    const { loading, error } = terminals.state;
    if (!loading && !error) {
      box?.runs.present(
        terminals.state.list.filter((item) => item.status === "running").map((
          item,
        ) => item.id),
      );
    }
    for (const [id, pane] of panes) bindRunTarget(id, pane);
    const refreshed = wasLoading && !loading;
    wasLoading = loading;
    const selected = terminals.state.selected;
    if (intent && !terminals.state.list.some((item) => item.id === intent)) {
      intent = "";
      store.update((state) => {
        state.preparing = "";
      });
    }
    if (!intent && selected && selected !== observed) select(selected);
    observed = selected;
    display();
    if (refreshed && box) {
      if (error) {
        fail(new FeedbackFailure(error), "Opening terminal");
      } else if (box.unavailable) {
        store.update((state) => {
          state.error = "";
        });
        box.markUnavailable(undefined);
      }
    }
    drain();
  });
  const stopRuns = box?.subscribe(drain);
  const stopTheme = theme.subscribe(() => {
    for (const pane of panes.values()) {
      pane.renderer?.theme(theme.snapshot().colors);
    }
  });
  const create = (): Promise<void> => {
    if (creating) return creating;
    store.update((state) => {
      state.creating = true;
      state.error = "";
    });
    creating = Promise.resolve().then(() => terminals.create(80, 24)).then(
      (info) => {
        if (alive) select(info.id);
      },
    ).catch((cause) => {
      fail(cause, "Creating terminal");
    }).finally(() => {
      creating = undefined;
      if (alive) {
        store.update((state) => {
          state.creating = false;
        });
        drain();
      }
    });
    return creating;
  };
  return {
    terminals,
    state: store.state,
    title,
    select,
    create,
    focus() {
      if (alive) panes.get(terminals.state.selected ?? "")?.renderer?.focus();
    },
    failure: (cause: unknown) => fail(cause, "Opening terminal"),
    selectedIndex: () =>
      terminals.state.list.findIndex((item) =>
        item.id === terminals.state.selected
      ),
    selectIndex(index: number) {
      const info = terminals.state.list[index];
      if (info) select(info.id);
    },
    closeIndex(index: number) {
      const info = terminals.state.list[index];
      if (info) return this.close(info.id);
    },
    async start() {
      await terminals.refresh();
      if (!alive) return;
      started = true;
      if (terminals.state.error) return;
      if (!terminals.state.list.length) {
        await create();
      } else {
        if (terminals.state.selected) select(terminals.state.selected);
      }
      drain();
    },
    wants(id: string) {
      return terminals.state.selected === id || store.state.preparing === id ||
        terminals.state.retained.includes(id);
    },
    mount(id: string, element: HTMLElement): () => void {
      const pane: Pane = { alive: true };
      panes.set(id, pane);
      void rendererFactory(element, {
        colors: theme.snapshot().colors,
        input: (bytes, origin) => {
          pane.attachment?.input(bytes);
          if (origin === "user" && pane.detachRun) box?.runs.input(id);
        },
        resize: (cols, rows) => pane.attachment?.resize(cols, rows),
        selection: (text) => {
          if (
            alive && terminals.state.selected === id &&
            store.state.selection !== text
          ) {
            store.update((state) => {
              state.selection = text;
            });
          }
        },
        meta: () => {},
      }).then((renderer) => {
        if (!alive || !pane.alive) {
          renderer.dispose();
          return;
        }
        pane.renderer = renderer;
        renderer.theme(theme.snapshot().colors);
        if (terminals.state.selected === id && !intent) intent = id;
        activate(id, pane);
      }).catch((cause) => fail(cause, "Opening terminal"));
      return () => {
        pane.alive = false;
        pane.detachRun?.();
        pane.attachment?.close();
        pane.renderer?.dispose();
        if (panes.get(id) === pane) panes.delete(id);
      };
    },
    async close(id: string) {
      if (store.state.closing.includes(id)) return;
      store.update((state) => {
        state.closing.push(id);
        state.error = "";
      });
      try {
        await terminals.close(id);
      } catch (cause) {
        fail(cause, "Closing terminal");
      } finally {
        if (alive) {
          store.update((state) => {
            state.closing = state.closing.filter((key) => key !== id);
          });
        }
      }
    },
    addSelection() {
      const id = terminals.state.selected;
      const text = panes.get(id ?? "")?.renderer?.selection() ?? "";
      if (!id || !text) return;
      const chip = terminalPrompt(text, title(id));
      add(chip.text, chip.label);
    },
    dispose() {
      alive = false;
      intent = "";
      unlisten();
      stopRuns?.();
      stopTheme();
      terminals.dispose();
      for (const pane of panes.values()) {
        pane.alive = false;
        pane.detachRun?.();
        pane.renderer?.dispose();
      }
      panes.clear();
    },
  };
}
export type TerminalPanelModel = ReturnType<typeof createTerminalPanel>;

/** Stable render factories follow terminal identity, never its changing ordinal. */
export function terminalTabs<T>(
  list: () => readonly TerminalInfo[],
  title: (id: string) => string,
  panel: (id: string) => T,
  closeable: (id: string) => boolean = () => true,
) {
  const tabs = new Map<
    string,
    {
      id: string;
      readonly label: string;
      readonly closeable: boolean;
      panel(): T;
    }
  >();
  return () => {
    const ids = new Set(list().map((info) => info.id));
    for (const id of tabs.keys()) if (!ids.has(id)) tabs.delete(id);
    return list().map(({ id }) => {
      let tab = tabs.get(id);
      if (!tab) {
        tabs.set(
          id,
          tab = {
            id,
            get label() {
              return title(id);
            },
            get closeable() {
              return closeable(id);
            },
            panel: () => panel(id),
          },
        );
      }
      return tab;
    });
  };
}
