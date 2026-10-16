// SPDX-License-Identifier: LGPL-3.0-only
import "./ProjectInbox.css" with { type: "text" };
import { createSignal, For, Show } from "solid-js";
import {
  type InboxProject,
  type MergedEntry,
  projectName,
  type ProjectSelection,
  type SidecarState,
} from "@otk/client";
import type { Preferences, ShellLayout } from "@otk/protocol";
import StatusLight from "./StatusLight.tsx";
import { resizeDrag } from "./resize.ts";
import {
  ChevronIcon,
  KeyboardIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "./ChromeIcons.tsx";
import { ownedAction, useCommandPorts } from "../keyboard/context.tsx";
export interface ProjectRow extends InboxProject {
  sidecarId: string;
  label: string;
}
export default function ProjectInbox(props: {
  projects: ProjectRow[];
  entries: MergedEntry[];
  servers: SidecarState[];
  selected?: ProjectSelection;
  prefs: Preferences;
  ready: boolean;
  onOpen(project: ProjectSelection): void;
  onInactive(project: ProjectSelection, value: boolean): Promise<void>;
  onLayout(patch: Partial<ShellLayout>): Promise<void>;
}): import("solid-js").Element {
  const [inactiveOpen, setInactiveOpen] = createSignal(false);
  const [dragWidth, setDragWidth] = createSignal<number>();
  let drag: ReturnType<typeof resizeDrag> | undefined;
  const [error, setError] = createSignal("");
  const { commands } = useCommandPorts();
  const commandTitle = (id: string, label: string) => {
    props.prefs.keymap;
    const keys = commands.list().find((row) => row.cmd.id === id)?.keys.join(
      " / ",
    );
    return keys ? `${label} (${keys})` : label;
  };
  const layout = () => props.prefs.shellLayout;
  const collapsed = () => layout().leftCollapsed;
  const width = () => collapsed() ? 48 : dragWidth() ?? layout().leftWidth;
  const save = async (patch: Partial<ShellLayout>) => {
    try {
      await props.onLayout(patch);
    } catch (error) {
      setError((error as Error).message);
    }
  };
  const open = ownedAction("project.open", props.onOpen);
  const inactive = ownedAction(
    "project.inactive",
    async (input: { project: ProjectRow; value: boolean }) => {
      try {
        await props.onInactive(input.project, input.value);
      } catch (error) {
        setError((error as Error).message);
      }
    },
  );
  const rows = () =>
    collapsed() ? props.projects : props.projects.filter((p) => !p.inactive);
  function Row(row: { project: ProjectRow }) {
    const project = () => row.project;
    const name = () => projectName(project().directory);
    const duplicate = () =>
      props.projects.filter((p) => projectName(p.directory) === name()).length >
        1;
    return (
      <div
        class="otk-project-row"
        data-project={project().directory}
        data-server={project().sidecarId}
        data-project-sessions={props.entries.filter((e) =>
          e.sidecarId === project().sidecarId &&
          e.directory === project().directory
        ).map((e) => e.id).join(" ")}
        data-inactive={project().inactive ? "true" : "false"}
        data-rollup={project().status}
      >
        <button
          type="button"
          class="otk-project-open"
          data-otk-selection="vertical"
          aria-label={`Open project ${name()}${
            duplicate() ? ` on ${project().label}` : ""
          }`}
          aria-current={props.selected?.sidecarId === project().sidecarId &&
              props.selected?.directory === project().directory
            ? "page"
            : undefined}
          title={`${project().directory} · ${project().label} · ${project().status}`}
          onClick={() => void open(project())}
        >
          <StatusLight state={project().status} />
          <Show when={!collapsed()}>
            <span class="otk-project-name-line">
              <span
                class={`otk-project-name otk-age-${project().ageing}`}
                data-unread={project().unread ? "true" : "false"}
              >
                {name()}
              </span>
              <Show when={duplicate()}>
                <span class="otk-project-machine">{project().label}</span>
              </Show>
            </span>
            <time class="otk-project-visit" title="Since last visit">
              {project().visitText}
            </time>
          </Show>
        </button>
        <Show when={!collapsed()}>
          <details class="otk-project-menu">
            <summary aria-label={`Project menu for ${name()}`}>⋯</summary>
            <div>
              <button
                type="button"
                onClick={() =>
                  void inactive({
                    project: project(),
                    value: !project().inactive,
                  })}
              >
                {project().inactive ? "Mark active" : "Mark inactive"}
              </button>
            </div>
          </details>
        </Show>
      </div>
    );
  }
  return (
    <aside
      class="otk-project-inbox"
      aria-label="Projects"
      data-collapsed={collapsed() ? "true" : "false"}
      style={{ width: `${width()}px` }}
    >
      <header class="otk-inbox-brand">
        <strong>OTK</strong>
        <button
          type="button"
          class="otk-icon-button otk-add-project"
          aria-label="Add project"
          title="Add project"
          onClick={() =>
            void commands.run("dialog.open", { id: "add-project" })}
        >
          <PlusIcon />
        </button>
      </header>
      <Show when={!collapsed()}>
        <nav class="otk-sidebar-commands" aria-label="Search">
          <button
            type="button"
            class="otk-inbox-search"
            title={commandTitle("palette.open", "Search commands")}
            onClick={() => void commands.run("palette.open")}
          >
            <SearchIcon /> Search
          </button>
        </nav>
      </Show>
      <div class="otk-inbox-scroll">
        <For each={rows()} keyed={(p) => `${p.sidecarId}/${p.directory}`}>
          {(p) => <Row project={p()} />}
        </For>
        <Show when={!collapsed() && props.projects.some((p) => p.inactive)}>
          <button
            type="button"
            class="otk-inactive-toggle"
            aria-expanded={inactiveOpen() ? "true" : "false"}
            onClick={() => setInactiveOpen(!inactiveOpen())}
          >
            <ChevronIcon />
            <span>Inactive</span>
            <span class="otk-inbox-rule" />
            <span>({props.projects.filter((p) => p.inactive).length})</span>
          </button>
          <Show when={inactiveOpen()}>
            <section
              aria-label="Inactive projects"
              class="otk-inactive-projects"
            >
              <For
                each={props.projects.filter((p) => p.inactive)}
                keyed={(p) => `${p.sidecarId}/${p.directory}`}
              >
                {(p) => <Row project={p()} />}
              </For>
            </section>
          </Show>
        </Show>
        <Show when={!collapsed() && !props.projects.length}>
          <p class="otk-muted otk-empty">Add a project to get started.</p>
        </Show>
      </div>
      <footer class="otk-inbox-footer">
        <button
          type="button"
          class="otk-icon-button otk-settings-entry"
          aria-label="Settings"
          title="Settings and server connections"
          onClick={() => void commands.run("settings.open")}
        >
          <SettingsIcon />
        </button>
        <button
          type="button"
          class="otk-icon-button otk-keys-entry"
          aria-label="Keyboard shortcuts"
          title={commandTitle("help.keys", "Keyboard shortcuts")}
          onClick={() => void commands.run("help.keys")}
        >
          <KeyboardIcon />
        </button>
        <div class="otk-server-connections" aria-label="Server connections">
          <For each={props.servers} keyed={(s) => s.id}>
            {(s) => (
              <section class="otk-server-connection">
                <button
                  type="button"
                  class="otk-server-status"
                  data-connection={s().id}
                  aria-label={`${s().label}: ${s().status}; agent service ${s().harness}`}
                  title={`${s().label}: ${s().status}; agent service ${s().harness}${
                    s().error ? `; ${s().error}` : ""
                  }`}
                  onClick={() => void commands.run("settings.open")}
                >
                  <StatusLight
                    small
                    label={`${s().label}: ${s().status}; agent service ${s().harness}`}
                    state={s().status === "connected" &&
                        s().harness === "connected"
                      ? "finished"
                      : s().error || s().status === "login required" ||
                          s().status === "setup required"
                      ? "blocked"
                      : "idle"}
                  />
                  <span>{s().label}</span>
                </button>
                <Show when={s().error}>
                  <p class="otk-error" role="alert">{s().error}</p>
                </Show>
              </section>
            )}
          </For>
        </div>
        <Show when={error()}>
          <p role="alert" class="otk-error">{error()}</p>
        </Show>
      </footer>
      <Show when={!collapsed()}>
        <div
          class="otk-inbox-resizer"
          role="separator"
          aria-label="Project column width"
          aria-orientation="vertical"
          tabindex="0"
          aria-valuemin={200}
          aria-valuemax={360}
          aria-valuenow={width()}
          onKeyDown={(event) => {
            if (
              !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
            ) return;
            event.preventDefault();
            const next = event.key === "Home"
              ? 200
              : event.key === "End"
              ? 360
              : Math.max(
                200,
                Math.min(360, width() + (event.key === "ArrowLeft" ? -8 : 8)),
              );
            void save({ leftWidth: next });
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag = resizeDrag(width(), event.clientX, 1, 200, 360);
            setDragWidth(width());
          }}
          onPointerMove={(event) => {
            if (
              !drag || !event.currentTarget.hasPointerCapture(event.pointerId)
            ) return;
            setDragWidth(drag(event.clientX));
          }}
          onPointerUp={(event) => {
            if (
              !drag || !event.currentTarget.hasPointerCapture(event.pointerId)
            ) return;
            const gesture = drag;
            event.currentTarget.releasePointerCapture(event.pointerId);
            void save({ leftWidth: gesture(event.clientX) }).finally(() => {
              if (drag !== gesture) return;
              drag = undefined;
              setDragWidth(undefined);
            });
          }}
          onPointerCancel={() => {
            drag = undefined;
            setDragWidth(undefined);
          }}
        />
      </Show>
    </aside>
  );
}
