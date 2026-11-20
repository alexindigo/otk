// SPDX-License-Identifier: LGPL-3.0-only
import {
  archiveAttention,
  countLabel,
  createProjectDisclosure,
  errorFeedback,
  type FailureValue,
  failureValue,
  type ProjectBranch,
  projectBranchPresentation,
  type ProjectDisclosure,
  projectGroup,
  projectTree,
} from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
import { EmptyState } from "./View.tsx";
import "./ProjectInbox.css" with { type: "text" };
import { selection } from "./selection.ts";
import SelectionContent from "./SelectionContent.tsx";
import { ControlIcon } from "./ControlValue.tsx";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import {
  projectName,
  type ProjectProjectionRow,
  type ProjectSelection,
  type SidecarState,
} from "@otk/client";
import {
  type Preferences,
  SHELL_WIDTHS,
  type ShellLayout,
} from "@otk/protocol";
import StatusLight from "./StatusLight.tsx";
import ConnectionLight from "./ConnectionLight.tsx";
import { connectionLabel } from "./connection-light.ts";
import { createResize } from "./resize.ts";
import { nativeAttributes } from "./native-attributes.ts";
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
import { ProjectAvatar } from "./ProjectChip.tsx";
import { TreeIcon, TreeItem, TreeNode } from "./Tree.tsx";
import ChromeMeta, { SectionHeaderMeta } from "./ChromeMeta.tsx";
import { solidState } from "../state/binding.ts";
export interface ProjectRow extends ProjectProjectionRow {
  sidecarId: string;
  label: string;
}
export default function ProjectInbox(props: {
  projects: ProjectRow[];
  duplicateName(name: string): boolean;
  servers: SidecarState[];
  selected?: ProjectSelection;
  prefs: Preferences;
  ready: boolean;
  onOpen(project: ProjectSelection): void;
  onInactive(project: ProjectSelection, value: boolean): Promise<void>;
  onLayout(patch: Partial<ShellLayout>): Promise<void>;
  onProjectCollapse?(
    project: ProjectSelection,
    collapsed: boolean,
  ): Promise<void>;
}): import("solid-js").Element {
  const disclosure = createProjectDisclosure(solidState);
  const inactiveDisclosure = disclosure.bind(
    "inactive",
    { directory: "" },
    () => false,
  );
  const inactiveOpen = inactiveDisclosure.open;
  const [error, setError] = createSignal<FailureValue>("");
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
    enabled: () => !collapsed() && inactiveRows().length > 0,
    run: () => inactiveDisclosure.set(!inactiveOpen()),
  });
  const hints = commandHints(ports);
  const layout = () => props.prefs.shellLayout;
  const collapsed = () => layout().leftCollapsed;
  const bounds = SHELL_WIDTHS.left;
  const resize = createResize({
    width: () => layout().leftWidth,
    ready: () => props.ready && !collapsed(),
    direction: 1,
    bounds,
    save: async (leftWidth) => {
      await props.onLayout({ leftWidth });
      setError("");
    },
    fail: (error) =>
      setError(failureValue(error, { actionLabel: "Saving project layout" })),
  });
  const width = resize.width;
  function DisclosureFeedback(item: { disclosure: ProjectDisclosure }) {
    const feedback = createMemo(() => {
      const cause = item.disclosure.error();
      if (!cause) return undefined;
      return {
        ...errorFeedback(
          failureValue(cause, { actionLabel: "Saving project tree" }),
        )!,
        action: { label: "Retry", run: () => item.disclosure.retry() },
      };
    });
    return (
      <Show when={feedback()}>
        <FeedbackStatus
          class="otk-project-disclosure-error"
          feedback={feedback()}
        />
      </Show>
    );
  }
  const open = ownedAction("project.open", props.onOpen, {
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string" },
        directory: { type: "string" },
      },
    },
  });
  ownedAction(
    "project.inactive",
    (input: { sidecarId: string; directory: string; value: boolean }) =>
      props.onInactive(input, input.value),
    {
      arguments: {
        type: "object",
        properties: {
          sidecarId: { type: "string" },
          directory: { type: "string" },
          value: { type: "boolean" },
        },
      },
      context: {
        kind: "project",
        title: (input) => input.value ? "Mark inactive" : "Mark active",
      },
      enabled: (_ctx, input) =>
        props.ready && !!input &&
        props.projects.some((project) =>
          project.sidecarId === input.sidecarId &&
          project.directory === input.directory &&
          projectGroup(project) !== "discovered"
        ),
    },
  );
  const discovered = () =>
    props.projects.filter((p) => projectGroup(p) === "discovered");
  const rows = () => props.projects.filter((p) => projectGroup(p) === "active");
  const inactiveRows = () =>
    props.projects.filter((p) => projectGroup(p) === "inactive");
  const repository = (p: ProjectRow) =>
    p.topology?.canonicalRoot ?? p.directory;
  const repositoryKey = (p: ProjectRow) =>
    JSON.stringify([p.sidecarId, repository(p)]);
  const liveRows = createMemo(() => projectTree(rows()));
  const archiveOwners = createMemo(() => {
    const owners = new Map<string, ProjectBranch<ProjectRow>>();
    for (const node of liveRows()) {
      const key = repositoryKey(node.project);
      if (owners.get(key)?.project.directory !== repository(node.project)) {
        owners.set(key, node);
      }
    }
    return owners;
  });
  const archivedRows = (repo: ProjectRow) =>
    props.projects.filter((p) =>
      projectGroup(p) === "archived" && p.sidecarId === repo.sidecarId &&
      repository(p) === repository(repo)
    );
  function Branches(section: { projects: ProjectRow[]; nested?: boolean }) {
    const nodes = createMemo(() => projectTree(section.projects));
    return (
      <For each={nodes()} keyed={(node) => node.key}>
        {(node) => (
          <TreeItem
            connected={!!section.nested}
            last={node().key === nodes().at(-1)?.key}
          >
            <ProjectNode node={node()} />
          </TreeItem>
        )}
      </For>
    );
  }
  function ProjectNode(
    item: { node: ProjectBranch<ProjectRow>; archive?: boolean },
  ) {
    const node = () => item.node;
    const archive = () =>
      !!item.archive && archivedRows(node().project).length > 0;
    const ownsNestedArchive = () =>
      archive() && node().project.directory === repository(node().project);
    const intent = disclosure.bind(
      "project",
      node().project,
      () => !layout().projectCollapsed?.[node().key],
      props.onProjectCollapse
        ? (value) => props.onProjectCollapse!(node().project, !value)
        : undefined,
    );
    const expanded = intent.open;
    const presentation = () =>
      projectBranchPresentation(
        node(),
        expanded(),
        archive()
          ? {
            ...archiveAttention(archivedRows(node().project)),
            requiredCount:
              archivedRows(node().project).filter((row) =>
                row.status !== "none"
              ).length,
          }
          : { count: 0, status: "none" },
      );
    const children = () => presentation().children;
    const nestedArchive = () =>
      ownsNestedArchive() && presentation().archiveVisible;
    const save = (value: boolean) => {
      void intent.set(value);
    };
    return (
      <Show
        when={!collapsed()}
        fallback={
          <>
            <Row project={node().project} />
            <For
              each={node().children}
              keyed={(child) => child.key}
            >
              {(child) => <ProjectNode node={child()} />}
            </For>
            <Show when={archive()}>
              <Archive repo={node().project} />
            </Show>
          </>
        }
      >
        <TreeNode
          class="otk-project-tree"
          label={`Worktrees in ${projectName(node().project.directory)}`}
          open={expanded()}
          hasChildren={presentation().hasChildren}
          showEmptyToggle={false}
          bodyVisible={children().length > 0 || nestedArchive()}
          onOpen={props.onProjectCollapse ? save : undefined}
          header={(connected) => (
            <Row
              project={node().project}
              connected={connected}
              protectedCount={!expanded() ? presentation().protectedCount : 0}
            />
          )}
          feedback={() => <DisclosureFeedback disclosure={intent} />}
          body={() => (
            <>
              <For each={children()} keyed={(child) => child.key}>
                {(child) => (
                  <TreeItem
                    last={!nestedArchive() &&
                      child().key === children().at(-1)?.key}
                  >
                    <ProjectNode node={child()} />
                  </TreeItem>
                )}
              </For>
              <Show when={nestedArchive()}>
                <TreeItem last>
                  <Archive repo={node().project} />
                </TreeItem>
              </Show>
            </>
          )}
        />
        <Show
          when={archive() && !ownsNestedArchive() &&
            presentation().archiveVisible}
        >
          <Archive repo={node().project} />
        </Show>
      </Show>
    );
  }
  const orphanArchives = createMemo(() => {
    const live = new Set(rows().map(repositoryKey));
    const repos = new Map<string, ProjectRow>();
    for (const project of props.projects) {
      if (
        projectGroup(project) === "archived" &&
        !live.has(repositoryKey(project))
      ) {
        repos.set(repositoryKey(project), project);
      }
    }
    return [...repos.values()];
  });
  function Archive(section: { repo: ProjectRow }) {
    const intent = disclosure.bind("archive", {
      sidecarId: section.repo.sidecarId,
      directory: repository(section.repo),
    }, () => false);
    const expanded = intent.open;
    const setExpanded = (value: boolean) => {
      void intent.set(value);
    };
    const projects = () => archivedRows(section.repo);
    const label = () =>
      `Archived checkouts in ${projectName(repository(section.repo))}`;
    const attention = () => archiveAttention(projects());
    const description = () =>
      `${label()}, ${attention().count}, ${
        attention().unseenCount === null
          ? "unseen count unavailable"
          : `${attention().unseenCount} unseen`
      }`;
    const header = () => (
      <button
        type="button"
        class="otk-archived-toggle"
        aria-label={description()}
        title={description()}
        data-rollup={attention().status}
        data-unseen-count={attention().unseenCount}
        aria-expanded={expanded() && !collapsed() ? "true" : "false"}
        onClick={() => {
          setExpanded(collapsed() || !expanded());
          if (collapsed()) {
            void props.onLayout({ leftCollapsed: false }).catch((error) =>
              setError(
                failureValue(error, {
                  actionLabel: "Opening archived projects",
                }),
              )
            );
          }
        }}
      >
        <TreeIcon>
          <StatusLight state={attention().status} />
        </TreeIcon>
        <Show when={!collapsed()}>
          <SectionHeaderMeta
            label="Archived"
            count={attention().count}
            metaClass="otk-archived-count"
          />
        </Show>
      </button>
    );
    return (
      <Show when={projects().length}>
        <section
          class="otk-project-archive"
          data-project-parent={repository(section.repo)}
        >
          <Show when={!collapsed()} fallback={header()}>
            <TreeNode
              class="otk-project-tree otk-archive-tree"
              label={label()}
              open={expanded()}
              onOpen={setExpanded}
              hasChildren
              header={header}
              body={() => (
                <section aria-label={label()} class="otk-archived-projects">
                  <Branches projects={projects()} nested />
                </section>
              )}
            />
          </Show>
        </section>
      </Show>
    );
  }
  const discoveredDisclosure = disclosure.bind(
    "discovered",
    { directory: "" },
    () => !layout().discoveredCollapsed,
    (value) => props.onLayout({ discoveredCollapsed: !value }),
  );
  const discoveredOpen = discoveredDisclosure.open;
  const toggleDiscovered = ownedAction("projects.discovered", async () => {
    await discoveredDisclosure.set(!discoveredOpen());
  });
  function Row(
    row: { project: ProjectRow; connected?: boolean; protectedCount?: number },
  ) {
    const [rowError, setRowError] = createSignal<FailureValue>("");
    const rowErrorID = `project-error-${createUniqueId()}`;
    const project = () => row.project;
    const target = () => ({
      kind: "project",
      data: {
        sidecarId: project().sidecarId,
        directory: project().directory,
        discovered: projectGroup(project()) === "discovered",
        value: !(project().inactivePolicy ?? project().inactive),
      },
    });
    const name = () =>
      project().displayName || projectName(project().directory);
    const duplicate = () => props.duplicateName(name());
    return (
      <div
        ref={contextTarget(target)}
        {...selection({
          class: `otk-project-row${project().depth ? " is-subproject" : ""}`,
          kind: "current",
          selected: props.selected?.sidecarId === project().sidecarId &&
            props.selected?.directory === project().directory,
        })}
        data-otk-selection="vertical"
        data-project={project().directory}
        data-server={project().sidecarId}
        data-project-sessions={project().sessionIDs}
        data-inactive={project().inactive ? "true" : "false"}
        data-source={project().source}
        data-group={projectGroup(project())}
        data-rollup={project().status}
        data-summary-authority={project().summary?.authority}
        data-project-parent={project().topology?.parentDirectory}
        data-project-repo={project().topology?.repoID}
        data-project-availability={project().availability}
        data-project-archived={project().archived ? "true" : "false"}
      >
        <SelectionContent class="otk-project-content">
          <button
            type="button"
            class="otk-project-open"
            aria-label={`Open project ${name()}${
              project().parentLabel ? ` in ${project().parentLabel}` : ""
            }${duplicate() ? ` on ${project().label}` : ""}${
              project().annotation ? `, ${project().annotation}` : ""
            }`}
            title={`${project().directory} · ${project().label}${
              projectGroup(project()) === "discovered"
                ? ""
                : ` - ${
                  project().status === "none"
                    ? "No known activity"
                    : project().status
                }`
            }${project().annotation ? `, ${project().annotation}` : ""}`}
            onClick={() => void open(project())}
          >
            <TreeIcon class="otk-project-marker">
              <StatusLight
                state={project().status}
                attention={{
                  server: project().sidecarId,
                  project: {
                    directory: project().directory,
                    repo: project().summary?.topology?.canonicalRoot ===
                        project().directory
                      ? project().summary?.topology?.repoID
                      : undefined,
                  },
                }}
              />
            </TreeIcon>
            <Show when={!collapsed()}>
              <span class="otk-project-name-line">
                <Show
                  when={project().artwork === "avatar" &&
                    (project().summary?.presentation?.name ||
                      project().summary?.presentation?.color)}
                >
                  <ProjectAvatar
                    name={name()}
                    color={project().summary?.presentation?.color}
                  />
                </Show>
                <span
                  class={`otk-project-name otk-age-${project().ageing}`}
                  data-unread={project().unread ? "true" : "false"}
                >
                  {name()}
                </span>
                <Show when={project().annotation}>
                  <span class="otk-project-availability">
                    {project().annotation}
                  </span>
                </Show>
                <Show when={project().inactive && project().parentLabel}>
                  <span
                    class="otk-project-parent otk-control-label"
                    title={project().topology?.canonicalRoot}
                  >
                    {project().parentLabel}
                  </span>
                </Show>
                <Show when={duplicate()}>
                  <span class="otk-project-machine">{project().label}</span>
                </Show>
                <Show when={row.protectedCount}>
                  <ChromeMeta class="otk-project-protected">
                    {countLabel(
                      row.protectedCount!,
                      "needs attention",
                      "need attention",
                    )}
                  </ChromeMeta>
                </Show>
              </span>
            </Show>
          </button>
          <Show when={!collapsed()}>
            <div class="otk-project-trailing">
              <Show when={(project().source ?? "tracked") === "tracked"}>
                <time
                  class="otk-project-visit otk-chrome-meta"
                  title="Since last visit"
                >
                  {project().visitText}
                </time>
              </Show>
              <CommandMenu
                class="otk-project-menu"
                triggerClass="otk-project-menu-trigger"
                label={`Project menu for ${name()}`}
                trigger="⋯"
                targets={() => [target()]}
                beforeRun={() => setRowError("")}
                onError={setRowError}
                feedbackID={rowErrorID}
              />
            </div>
          </Show>
          <Show when={rowError()}>
            <span
              id={rowErrorID}
              class="otk-error otk-project-error"
            >
              <FeedbackStatus feedback={errorFeedback(rowError())} />
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
              void add().catch((error) =>
                setError(failureValue(error, { actionLabel: "Adding project" }))
              )}
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
            <ControlIcon>
              <SearchIcon class="otk-inbox-search-icon" />
            </ControlIcon>
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
                    aria-label={connectionLabel(s())}
                    title={connectionLabel(s())}
                    onClick={() => void commands.run("settings.open")}
                  >
                    <ControlIcon>
                      <ConnectionLight small connection={s()} />
                    </ControlIcon>
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
            <FeedbackStatus feedback={errorFeedback(error())} />
          </Show>
        </footer>
      }
      resizer={
        <Show when={!collapsed()}>
          {(_expanded) => {
            const native = nativeAttributes(() => resize.handlers);
            return (
              <div
                ref={native.ref}
                class="otk-inbox-resizer"
                role="separator"
                aria-label="Project column width"
                aria-orientation="vertical"
                tabindex={props.ready ? 0 : -1}
                aria-valuemin={bounds.min}
                aria-valuemax={bounds.max}
                aria-valuenow={width()}
                {...native.attributes}
              />
            );
          }}
        </Show>
      }
    >
      <For
        each={liveRows()}
        keyed={(p) => p.key}
      >
        {(p) => (
          <ProjectNode
            node={p()}
            archive={archiveOwners().get(repositoryKey(p().project))?.key ===
              p().key}
          />
        )}
      </For>
      <For each={orphanArchives()} keyed={repositoryKey}>
        {(repo) => <Archive repo={repo()} />}
      </For>
      <Show when={discovered().length}>
        <button
          type="button"
          class="otk-discovered-toggle"
          aria-label={`Discovered projects, ${discovered().length}`}
          title={`Discovered projects, ${discovered().length}`}
          aria-expanded={discoveredOpen() ? "true" : "false"}
          onClick={() =>
            void toggleDiscovered().catch((error) =>
              setError(
                failureValue(error, { actionLabel: "Saving project layout" }),
              )
            )}
        >
          <ControlIcon>
            <ChevronIcon class="otk-discovered-chevron" />
          </ControlIcon>
          <Show when={!collapsed()}>
            <SectionHeaderMeta label="Discovered" count={discovered().length} />
          </Show>
        </button>
        <DisclosureFeedback disclosure={discoveredDisclosure} />
        <section
          aria-label="Discovered projects"
          class="otk-discovered-projects"
        >
          <Branches
            projects={discovered().filter((p) =>
              discoveredOpen() || p.status !== "none"
            )}
          />
        </section>
      </Show>
      <Show when={!collapsed() && inactiveRows().length}>
        <button
          type="button"
          class="otk-inactive-toggle"
          aria-expanded={inactiveOpen() ? "true" : "false"}
          onClick={() =>
            void inactive().catch((error) =>
              setError(
                failureValue(error, {
                  actionLabel: "Changing inactive projects",
                }),
              )
            )}
        >
          <ControlIcon>
            <ChevronIcon class="otk-inactive-chevron" />
          </ControlIcon>
          <SectionHeaderMeta label="Inactive" count={inactiveRows().length} />
        </button>
        <Show when={inactiveOpen()}>
          <section aria-label="Inactive projects" class="otk-inactive-projects">
            <Branches projects={inactiveRows()} />
          </section>
        </Show>
      </Show>
      <Show when={collapsed()}>
        <For
          each={inactiveRows()}
          keyed={(p) => `${p.sidecarId}/${p.directory}`}
        >
          {(p) => <Row project={p()} />}
        </For>
      </Show>
      <Show when={!collapsed() && !props.projects.length}>
        <EmptyState>Add a project to get started.</EmptyState>
      </Show>
    </SidebarRail>
  );
}
