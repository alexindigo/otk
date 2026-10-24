// SPDX-License-Identifier: LGPL-3.0-only
import { EmptyState } from "./View.tsx";
import "./ProjectInbox.css" with { type: "text" };
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import { createSignal, For, Show } from "solid-js";
import {
  type InboxProject,
  type MergedEntry,
  projectName,
  type ProjectSelection,
  type SidecarState,
} from "@otk/client";
import {
  type Preferences,
  SHELL_WIDTHS,
  type ShellLayout,
} from "@otk/protocol";
import StatusLight from "./StatusLight.tsx";
import { resizeDrag } from "./resize.ts";
import {
  ChevronIcon,
  KeyboardIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "./ChromeIcons.tsx";
import {
  commandHints,
  ownedAction,
  ownedCommand,
  useCommandPorts,
} from "../keyboard/context.tsx";
import CommandMenu from "./CommandMenu.tsx";
import SidebarRail from "./SidebarRail.tsx";
import { contextTarget } from "./context-target.ts";
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
  const ports = useCommandPorts(), { commands } = ports;
  const add = ownedCommand(ports, {
    id: "project.add",
    title: "Add project",
    category: "Projects",
    context: { kind: "projects", order: 0 },
    enabled: () =>
      commands.enabled("dialog.open", undefined, { id: "add-project" }),
    run: () => commands.run("dialog.open", { id: "add-project" }),
  });
  const inactive = ownedCommand(ports, {
    id: "projects.inactive",
    title: "Show inactive projects",
    category: "Projects",
    context: {
      kind: "projects",
      order: 30,
      title: () =>
        inactiveOpen() ? "Hide inactive projects" : "Show inactive projects",
    },
    enabled: () =>
      !collapsed() && props.projects.some((project) => project.inactive),
    run: () => setInactiveOpen(!inactiveOpen()),
  });
  const hints = commandHints(ports);
  const layout = () => props.prefs.shellLayout;
  const collapsed = () => layout().leftCollapsed;
  const bounds = SHELL_WIDTHS.left;
  const width = () => dragWidth() ?? layout().leftWidth;
  const save = async (patch: Partial<ShellLayout>) => {
    try {
      await props.onLayout(patch);
    } catch (error) {
      setError((error as Error).message);
    }
  };
  const open = ownedAction("project.open", props.onOpen);
  ownedAction(
    "project.inactive",
    (input: { sidecarId: string; directory: string; value: boolean }) =>
      props.onInactive(input, input.value),
    {
      context: {
        kind: "project",
        title: (input) => input.value ? "Mark inactive" : "Mark active",
      },
      enabled: (_ctx, input) =>
        props.ready && !!input &&
        props.projects.some((project) =>
          project.sidecarId === input.sidecarId &&
          project.directory === input.directory
        ),
    },
  );
  const rows = () =>
    collapsed() ? props.projects : props.projects.filter((p) => !p.inactive);
  function Row(row: { project: ProjectRow }) {
    const [rowError, setRowError] = createSignal("");
    const project = () => row.project;
    const target = () => ({
      kind: "project",
      data: {
        sidecarId: project().sidecarId,
        directory: project().directory,
        value: !project().inactive,
      },
    });
    const name = () => projectName(project().directory);
    const duplicate = () =>
      props.projects.filter((p) => projectName(p.directory) === name()).length >
        1;
    return (
      <div
        ref={contextTarget(target)}
        {...selection({
          class: "otk-project-row",
          kind: "current",
          selected: props.selected?.sidecarId === project().sidecarId &&
            props.selected?.directory === project().directory,
        })}
        data-otk-selection="vertical"
        data-project={project().directory}
        data-server={project().sidecarId}
        data-project-sessions={props.entries.filter((e) =>
          e.sidecarId === project().sidecarId &&
          e.directory === project().directory
        ).map((e) => e.id).join(" ")}
        data-inactive={project().inactive ? "true" : "false"}
        data-rollup={project().status}
      >
        <SelectionContent class="otk-project-content">
          <button
            type="button"
            class="otk-project-open"
            aria-label={`Open project ${name()}${
              duplicate() ? ` on ${project().label}` : ""
            }`}
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
            </Show>
          </button>
          <Show when={!collapsed()}>
            <div class="otk-project-trailing">
              <time class="otk-project-visit" title="Since last visit">
                {project().visitText}
              </time>
              <CommandMenu
                class="otk-project-menu"
                triggerClass="otk-project-menu-trigger"
                label={`Project menu for ${name()}`}
                trigger="⋯"
                targets={() => [target()]}
                beforeRun={() => setRowError("")}
                onError={setRowError}
              />
            </div>
          </Show>
          <Show when={rowError()}>
            <span class="otk-error otk-project-error" role="alert">
              {rowError()}
            </span>
          </Show>
        </SelectionContent>
      </div>
    );
  }
  return (
    <SidebarRail
      ref={contextTarget(() => ({
        kind: "projects",
        area: true,
        data: undefined,
      }))}
      class="otk-project-inbox"
      label="Projects"
      side="left"
      collapsed={collapsed()}
      width={width()}
      bodyClass="otk-inbox-scroll"
      header={
        <div class="otk-inbox-brand">
          <strong>OTK</strong>
          <button
            type="button"
            class="otk-icon-button otk-add-project"
            aria-label="Add project"
            title="Add project"
            onClick={() =>
              void add().catch((error) => setError((error as Error).message))}
          >
            <PlusIcon />
          </button>
        </div>
      }
      leading={
        <nav class="otk-sidebar-commands" aria-label="Search">
          <button
            type="button"
            class="otk-inbox-search"
            aria-label="Search commands"
            title={hints.title("palette.open", "Search commands")}
            onClick={() => void commands.run("palette.open")}
          >
            <SearchIcon class="otk-inbox-search-icon" />
            <Show when={!collapsed()}>Search</Show>
          </button>
        </nav>
      }
      footer={
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
            title={hints.title("help.keys", "Keyboard shortcuts")}
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
                    <span class="otk-server-label">{s().label}</span>
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
      }
      resizer={
        <Show when={!collapsed()}>
          <div
            class="otk-inbox-resizer"
            role="separator"
            aria-label="Project column width"
            aria-orientation="vertical"
            tabindex="0"
            aria-valuemin={bounds.min}
            aria-valuemax={bounds.max}
            aria-valuenow={width()}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              ) return;
              event.preventDefault();
              const next = event.key === "Home"
                ? bounds.min
                : event.key === "End"
                ? bounds.max
                : Math.max(
                  bounds.min,
                  Math.min(
                    bounds.max,
                    width() + (event.key === "ArrowLeft" ? -8 : 8),
                  ),
                );
              void save({ leftWidth: next });
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              drag = resizeDrag(
                width(),
                event.clientX,
                1,
                bounds.min,
                bounds.max,
              );
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
      }
    >
      <For each={rows()} keyed={(p) => `${p.sidecarId}/${p.directory}`}>
        {(p) => <Row project={p()} />}
      </For>
      <Show when={!collapsed() && props.projects.some((p) => p.inactive)}>
        <button
          type="button"
          class="otk-inactive-toggle"
          aria-expanded={inactiveOpen() ? "true" : "false"}
          onClick={() =>
            void inactive().catch((error) =>
              setError((error as Error).message)
            )}
        >
          <ChevronIcon class="otk-inactive-chevron" />
          <span>Inactive</span>
          <span class="otk-inbox-rule" />
          <span>({props.projects.filter((p) => p.inactive).length})</span>
        </button>
        <Show when={inactiveOpen()}>
          <section aria-label="Inactive projects" class="otk-inactive-projects">
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
        <EmptyState>Add a project to get started.</EmptyState>
      </Show>
    </SidebarRail>
  );
}
