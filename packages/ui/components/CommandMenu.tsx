// SPDX-License-Identifier: LGPL-3.0-only
import { failureText } from "@otk/client";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  type Element,
  For,
  onSettled,
  Show,
} from "solid-js";
import {
  type ContextAction,
  contextGroups,
  type ContextTarget,
} from "@otk/client";
import { useCommandPorts } from "../keyboard/context.tsx";
import Menu from "./surface/Menu.tsx";
import type { PopoverControl } from "./surface/Popover.tsx";
import { commandRows } from "./list-presentation.ts";
import FeedbackStatus from "./FeedbackStatus.tsx";
import ActionSlot from "./ActionSlot.tsx";
import "./CommandMenu.css" with { type: "text" };

/** Shared hub projection, invocation and feedback for every command-menu entry. */
export default function CommandMenu(props: {
  label: string;
  class?: string;
  trigger?: Element;
  triggerClass?: string;
  targets(): readonly ContextTarget[];
  control?(control: PopoverControl): void;
  beforeRun?(): void;
  onClose?(): void;
  onError?(text: string): void;
  /** Description owned by an injected error sink instead of the menu's track. */
  feedbackID?: string;
}): Element {
  const ports = useCommandPorts(), { commands } = ports;
  const [captured, setCaptured] = createSignal<readonly ContextTarget[]>();
  const [revision, setRevision] = createSignal(0);
  const [groups, setGroups] = createSignal<ContextAction[][]>([]);
  const rows = createMemo(() => groups().map(commandRows));
  const [error, setError] = createSignal<{ key: string; text: string }>();
  const [armed, setArmed] = createSignal<{
    key: string;
    title: string;
    action: ContextAction;
  }>();
  const [pending, setPending] = createSignal<string>();
  const errorId = `context-error-${createUniqueId()}`;
  let menu!: PopoverControl, generation = 0;
  const clear = () => {
    generation++;
    setCaptured(undefined);
    setGroups([]);
    setError(undefined);
    setArmed(undefined);
    setPending(undefined);
    props.onClose?.();
  };
  const capture = () => {
    generation++;
    setError(undefined);
    setArmed(undefined);
    setPending(undefined);
    const targets = props.targets();
    setCaptured(targets);
    const next = contextGroups(commands, targets);
    setGroups(next);
    return next.length > 0;
  };
  onSettled(() =>
    commands.subscribe(() => {
      // Registry churn only requests reprojection. The validity check below
      // owns disarming an action whose availability or confirmation changed.
      setRevision((value) => value + 1);
    })
  );
  createEffect(() => {
    revision();
    const targets = captured();
    return targets && contextGroups(commands, targets);
  }, (next) => {
    if (!next) return;
    setGroups(next);
    const active = armed();
    if (
      active &&
      !next.flat().some((item) =>
        item.key === active.key && item.confirm === active.title &&
        commands.sameContextOwner(active.action, item)
      )
    ) setArmed(undefined);
    if (!next.length) menu.close();
  });
  const run = async (
    action: ContextAction,
    focusPending: () => void,
    focusAction: () => void,
  ) => {
    if (pending()) return;
    const current = generation;
    setError(undefined);
    const next = contextGroups(commands, captured() ?? []);
    setGroups(next);
    const item = next.flat().find((item) => item.key === action.key);
    if (!item) {
      if (!next.length) menu.close();
      return;
    }
    if (
      item.confirm &&
      (armed()?.key !== item.key || armed()?.title !== item.confirm ||
        !commands.sameContextOwner(armed()!.action, item))
    ) {
      setArmed({ key: item.key, title: item.confirm, action: item });
      return;
    }
    setArmed(undefined);
    setPending(item.key);
    props.beforeRun?.();
    const origin = document.activeElement;
    onSettled(() => {
      // A command may hand focus to its consumer synchronously. Pending paint
      // owns only the invocation's old focus, never that newly focused control.
      if (
        current === generation && pending() &&
        (document.activeElement === origin ||
          document.activeElement === document.body)
      ) focusPending();
    });
    try {
      await commands.runContext(action);
      if (current === generation) menu.close(() => {});
    } catch (cause) {
      if (current !== generation) return;
      if (ports.failureOwned?.(cause)) {
        menu.close();
        return;
      }
      const text = failureText(cause);
      setError({ key: action.key, text });
      props.onError?.(text);
    } finally {
      if (current === generation) {
        setPending(undefined);
        onSettled(() => {
          if (current === generation) focusAction();
        });
      }
    }
  };
  return (
    <Menu
      label={props.label}
      class={props.class}
      trigger={props.trigger}
      triggerClass={props.triggerClass}
      dismissOnAction={false}
      control={(control) => {
        menu = control;
        props.control?.({
          open: (anchor, reason) => {
            if (capture()) control.open(anchor, reason);
            else clear();
          },
          close: (focus) => {
            control.close(focus);
            clear();
          },
          contains: control.contains,
        });
      }}
      onOpen={() => {
        if (!captured() && !capture()) menu.close();
      }}
      onClose={clear}
      onItemChange={() => setArmed(undefined)}
      status={
        <Show when={error() && !props.onError}>
          <FeedbackStatus
            id={errorId}
            feedback={{ kind: "error", text: error()!.text }}
          />
        </Show>
      }
    >
      <For each={rows()} keyed={false}>
        {(group, index) => (
          <>
            <Show when={index > 0}>
              <hr role="separator" />
            </Show>
            <div role="group">
              <For each={group()} keyed={(row) => row.action.key}>
                {(row) => {
                  const action = () => row().action;
                  let status: { focus(): void } | undefined,
                    button!: HTMLButtonElement;
                  return (
                    <>
                      <Show
                        when={row().separator}
                      >
                        <hr role="separator" />
                      </Show>
                      <ActionSlot
                        class="otk-command-menu-row"
                        pending={!!pending()}
                        feedback={pending() === action().key
                          ? { kind: "pending", text: "Working…" }
                          : undefined}
                        control={(control) => status = control}
                        focusAction={() => button.focus()}
                      >
                        <button
                          ref={(element) => button = element}
                          type="button"
                          role="menuitem"
                          data-context-command={action().id}
                          aria-describedby={error()?.key === action().key
                            ? props.feedbackID ??
                              (props.onError ? undefined : errorId)
                            : undefined}
                          aria-busy={pending() === action().key
                            ? "true"
                            : undefined}
                          class={[
                            "otk-command-menu-button",
                            action().destructive ? "otk-menu-destructive" : "",
                            armed()?.key === action().key ? "is-armed" : "",
                          ].filter(Boolean).join(" ")}
                          onClick={() =>
                            void run(action(), () => status?.focus(), () =>
                              button.focus())}
                        >
                          <span
                            class="otk-control-label"
                            title={armed()?.key === action().key
                              ? action().confirm
                              : action().title}
                          >
                            {armed()?.key === action().key
                              ? action().confirm
                              : action().title}
                          </span>
                        </button>
                      </ActionSlot>
                    </>
                  );
                }}
              </For>
            </div>
          </>
        )}
      </For>
    </Menu>
  );
}
