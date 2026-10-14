// SPDX-License-Identifier: LGPL-3.0-only
import "./Sidebar.css" with { type: "text" };
import { createSignal, For, onSettled, Show } from "solid-js";
import {
  type MergedEntry,
  projectGroups,
  sessionKey,
  type SidecarState,
} from "@otk/client";
import ConnectionBadge from "./ConnectionBadge.tsx";
import { ownedAction } from "../keyboard/context.tsx";
export function shortDirectory(directory: string): string {
  return directory.split(/[\\/]/).filter(Boolean).slice(-2).join("/") ||
    directory;
}
function relative(time: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  return minutes < 1
    ? "now"
    : minutes < 60
    ? `${minutes}m`
    : minutes < 1440
    ? `${Math.floor(minutes / 60)}h`
    : `${Math.floor(minutes / 1440)}d`;
}
export default function Sidebar(
  props: {
    sidecars: SidecarState[];
    entries: MergedEntry[];
    selected?: string;
    onOpen(entry: MergedEntry): void;
    onCreate(sidecarId: string, directory: string): void;
    onSettings(): void;
    actions?: import("solid-js").Element;
  },
): import("solid-js").Element {
  const [now, setNow] = createSignal(Date.now());
  const open = ownedAction(
    "sidebar.session.open",
    (entry: MergedEntry) => props.onOpen(entry),
  );
  const create = ownedAction(
    "sidebar.session.new",
    (input: { id: string; directory: string }) =>
      props.onCreate(input.id, input.directory),
  );
  const settings = ownedAction("sidebar.settings", () => props.onSettings());
  onSettled(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  });
  return (
    <aside class="otk-sidebar" aria-label="Sessions">
      <header class="otk-brand">
        <strong>OTK</strong>
        <span>OPEN TERMINAL KIT</span>
      </header>
      <Show when={props.actions}>
        <nav class="otk-sidebar-commands" aria-label="Commands">
          {props.actions}
        </nav>
      </Show>
      <div class="otk-sidebar-scroll">
        <For each={props.sidecars} keyed={(item) => item.id}>
          {(sidecar) => (
            <section class="otk-sidecar-group" data-sidecar={sidecar().id}>
              <h2>{sidecar().label}</h2>
              <ConnectionBadge sidecar={sidecar()} />
              <Show when={sidecar().error}>
                <p class="otk-error" role="alert">{sidecar().error}</p>
              </Show>
              <Show
                when={sidecar().status === "login required" ||
                  sidecar().status === "setup required"}
              >
                <button
                  type="button"
                  onClick={() =>
                    void settings()}
                >
                  Configure connection
                </button>
              </Show>
              <For
                each={projectGroups(props.entries, sidecar().id)}
                keyed={(item) =>
                  item.directory}
              >
                {(group) => (
                  <section class="otk-project" data-project={group().directory}>
                    <div class="otk-project-header">
                      <h3 title={group().directory}>
                        {shortDirectory(group().directory)}
                      </h3>
                      <button
                        type="button"
                        class="otk-new-session"
                        aria-label={`New session in ${group().directory}`}
                        disabled={sidecar().status !== "connected"}
                        onClick={() =>
                          void create({
                            id: sidecar().id,
                            directory: group().directory,
                          })}
                      >
                        +
                      </button>
                    </div>
                    <For
                      each={group().entries}
                      keyed={(item) =>
                        item.id}
                    >
                      {(entry) => (
                        <button
                          type="button"
                          class={["otk-session-row", {
                            "otk-selected": props.selected ===
                              sessionKey(entry().sidecarId, entry().id),
                          }]}
                          data-session={entry().id}
                          data-status={entry().status}
                          aria-current={props.selected ===
                              sessionKey(entry().sidecarId, entry().id)
                            ? "page"
                            : undefined}
                          onClick={() => void open(entry())}
                        >
                          <span class="otk-row-title">{entry().title}</span>
                          <time
                            datetime={new Date(entry().timeUpdated)
                              .toISOString()}
                          >
                            {relative(entry().timeUpdated, now())}
                          </time>
                          <span class="otk-row-status">
                            <span
                              class={["otk-dot", {
                                "otk-busy": entry().status === "busy",
                                "otk-retry": entry().status === "retry",
                              }]}
                            />
                            {entry().status === "retry"
                              ? `retry ${entry().retry?.attempt ?? ""}`
                              : entry().status}
                          </span>
                          <span class="otk-attention">
                            <Show
                              when={entry().attention.permissions +
                                entry().attention.childPermissions}
                            >
                              {(count) => (
                                <span title="Pending permissions">
                                  P {count()}
                                </span>
                              )}
                            </Show>
                            <Show
                              when={entry().attention.questions +
                                entry().attention.childQuestions}
                            >
                              {(count) => (
                                <span title="Pending questions">
                                  Q {count()}
                                </span>
                              )}
                            </Show>
                            <Show when={entry().attention.error}>
                              <span
                                class={["otk-dot", "otk-error-dot"]}
                                title={entry().attention.error}
                                aria-label="Session error"
                              />
                            </Show>
                          </span>
                        </button>
                      )}
                    </For>
                  </section>
                )}
              </For>
            </section>
          )}
        </For>
        <Show when={!props.entries.some((entry) => !entry.parentID)}>
          <p class="otk-muted otk-empty">
            No sessions yet. Create a session in opencode to start a project.
          </p>
        </Show>
      </div>
      <button
        type="button"
        class="otk-settings-entry"
        onClick={() => void settings()}
      >
        Settings / sidecars
      </button>
    </aside>
  );
}
