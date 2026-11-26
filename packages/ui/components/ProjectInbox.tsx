// SPDX-License-Identifier: LGPL-3.0-only
import {
  errorFeedback,
  type FailureValue,
  failureValue,
  type ProjectBranch,
  projectBranchPresentation,
  projectGroup,
  projectTree,
  type TreeDisclosures,
} from "@otk/client";
import { archiveEntityID, entityKey, UNKNOWN_REPOSITORY } from "@otk/protocol";
import { type EntityStateStore, label as stateLabel, lamp } from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
import { EmptyState } from "./View.tsx";
import "./ProjectInbox.css" with { type: "text" };
import SidebarRow from "./SidebarRow.tsx";
import { ControlIcon } from "./ControlValue.tsx";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import {
  checkoutLabel,
  projectLabel,
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
import ConnectionBadge from "./ConnectionBadge.tsx";
import { createResize } from "./resize.ts";
import { nativeAttributes } from "./native-attributes.ts";
import {
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
import { TreeIcon, TreeItem, TreeNode } from "./Tree.tsx";
import ChromeMeta, {
  metaList,
  MetaText,
  SectionHeader,
} from "./ChromeMeta.tsx";
import TimeText from "./TimeText.tsx";
import DisclosureFeedback from "./DisclosureFeedback.tsx";
import { orderInteraction } from "./order-interaction.ts";
import { connectionFeedback } from "./connection-light.ts";
export interface ProjectRow extends ProjectProjectionRow {
  sidecarId: string;
  label: string;
}
export default function ProjectInbox(props: {
  disclosure: TreeDisclosures;
  projects: ProjectRow[];
  duplicateName(name: string): boolean;
  projectLabel?(sidecarId: string, directory: string): string;
  servers: SidecarState[];
  selected?: ProjectSelection;
  prefs: Preferences;
  ready: boolean;
  history?: import("solid-js").Element;
  holdOrder?(): () => void;
  onOpen(project: ProjectSelection): void;
  onAttention?(project: ProjectSelection): void;
  onInactive(project: ProjectSelection, value: boolean): Promise<void>;
  onLayout(patch: Partial<ShellLayout>): Promise<void>;
  onProjectCollapse?(
    project: ProjectSelection,
    collapsed: boolean,
  ): Promise<void>;
  /** The connection's entity states; standalone consumers present rows'. */
  entities?(server: string): EntityStateStore;
}): import("solid-js").Element {
  const disclosure = props.disclosure;
  const orderInput = orderInteraction(() => props.holdOrder?.() ?? (() => {}));
  const inactiveDisclosure = disclosure.bind(
    "inactive",
    { id: "" },
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
  ownedCommand(ports, {
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
  const open = ownedAction("project.open", props.onOpen, {
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string" },
        directory: { type: "string" },
      },
    },
  });
  const openAttention = ownedAction(
    "project.attention",
    props.onAttention ?? props.onOpen,
    {
      arguments: {
        type: "object",
        properties: {
          sidecarId: { type: "string" },
          directory: { type: "string" },
        },
      },
    },
  );
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
      { sidecarId: node().project.sidecarId, id: node().project.directory },
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
        archive() ? archivedRows(node().project).length : 0,
      );
    const children = () => presentation().children;
    const nestedArchive = () =>
      ownsNestedArchive() && presentation().archiveVisible;
    const save = (value: boolean) => {
      void intent.set(value);
    };
    return (
      <>
        <TreeNode
          compact={collapsed()}
          leadingRow
          selected={props.selected?.sidecarId === node().project.sidecarId &&
            props.selected?.directory === node().project.directory}
          class="otk-project-tree otk-sidebar-tree"
          label={`Worktrees in ${node().project.displayName}`}
          open={expanded()}
          hasChildren={presentation().hasChildren}
          showEmptyToggle={false}
          bodyVisible={children().length > 0 || nestedArchive()}
          onOpen={props.onProjectCollapse ? save : undefined}
          header={(connected) => (
            <Row
              project={node().project}
              connected={connected}
            />
          )}
          feedback={() => (
            <DisclosureFeedback
              disclosure={intent}
              actionLabel="Saving project tree"
              class="otk-project-disclosure-error"
            />
          )}
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
      </>
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
      id: repository(section.repo),
    }, () => false);
    const expanded = intent.open;
    const setExpanded = (value: boolean) => {
      void intent.set(value);
    };
    const projects = () => archivedRows(section.repo);
    const unknown = () => repository(section.repo) === UNKNOWN_REPOSITORY;
    const label = () =>
      unknown()
        ? "Checkouts with unknown repository"
        : `Archived checkouts in ${
          props.projectLabel?.(
            section.repo.sidecarId,
            section.repo.directory,
          ) ?? projectLabel(section.repo.directory, section.repo.summary)
        }`;
    const archive = () => props.entities?.(section.repo.sidecarId);
    const key = () => entityKey("archive", archiveEntityID(section.repo));
    const attention = () => {
      const store = archive();
      return {
        count: projects().length,
        status: store ? lamp(store, key()) : "none" as const,
        unseenCount: store && !store.isStale
          ? store.get(key())?.counts.unseen ?? 0
          : null,
      };
    };
    const description = () =>
      `${label()}, ${attention().count}, ${
        attention().unseenCount === null
          ? "unseen count unavailable"
          : `${attention().unseenCount} unseen`
      }`;
    const change = (value: boolean) => {
      setExpanded(collapsed() || value);
      if (collapsed()) {
        void props.onLayout({ leftCollapsed: false }).catch((error) =>
          setError(
            failureValue(error, {
              actionLabel: "Opening archived projects",
            }),
          )
        );
      }
    };
    return (
      <Show when={projects().length}>
        <section
          class="otk-project-archive"
          data-project-parent={repository(section.repo)}
        >
          <SectionHeader
            sidebar
            class="otk-project-tree otk-archive-tree"
            headerClass="otk-archived-toggle"
            metaClass="otk-archived-count"
            label={unknown() ? "Unknown repository" : "Archived"}
            description={description()}
            count={attention().count}
            compact={collapsed()}
            open={expanded() && !collapsed()}
            onOpen={change}
            attributes={{
              "data-rollup": attention().status,
              "data-unseen-count": attention().unseenCount,
            }}
            leading={() => (
              <TreeIcon>
                <StatusLight state={attention().status} />
              </TreeIcon>
            )}
            body={() => (
              <section aria-label={label()} class="otk-archived-projects">
                <Branches projects={projects()} nested />
              </section>
            )}
          />
        </section>
      </Show>
    );
  }
  const discoveredDisclosure = disclosure.bind(
    "discovered",
    { id: "" },
    () => !layout().discoveredCollapsed,
    (value) => props.onLayout({ discoveredCollapsed: !value }),
  );
  const discoveredOpen = discoveredDisclosure.open;
  const toggleDiscovered = ownedAction(
    "projects.discovered",
    async (value: boolean) => {
      await discoveredDisclosure.set(value);
    },
    { arguments: { type: "boolean" } },
  );
  function Row(
    row: { project: ProjectRow; connected?: boolean },
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
      project().displayName ??
        checkoutLabel(project().directory, project().summary);
    const duplicate = () => props.duplicateName(name());
    const key = () => entityKey("project", project().directory);
    const entities = () => props.entities?.(project().sidecarId);
    const lampLabel = () => stateLabel(project().status);
    return (
      <SidebarRow
        frame={{
          ref: contextTarget(target),
          class: `otk-project-row otk-sidebar-selection${
            project().depth ? " is-subproject" : ""
          }`,
          selected: props.selected?.sidecarId === project().sidecarId &&
            props.selected?.directory === project().directory,
          attributes: {
            "data-project": project().directory,
            "data-server": project().sidecarId,
            "data-project-sessions": project().sessionIDs,
            "data-inactive": project().inactive ? "true" : "false",
            "data-source": project().source,
            "data-group": projectGroup(project()),
            "data-rollup": project().status,
            "data-summary-authority": project().summary?.authority,
            "data-project-parent": project().topology?.parentDirectory,
            "data-project-repo": project().topology?.repoID,
            "data-project-availability": project().availability,
            "data-project-archived": project().archived ? "true" : "false",
          },
        }}
        compact={collapsed()}
        detailedMeta={!!project().annotation ||
          (project().visit?.parts.length ?? 0) > 1}
        lamp={
          <TreeIcon class="otk-project-marker">
            <button
              type="button"
              class="otk-project-attention"
              aria-label={project().status === "none"
                ? `Open project ${name()}`
                : `${lampLabel()}: open session in ${name()}`}
              title={project().status === "none"
                ? `Open project ${project().directory}`
                : `${lampLabel()}: open session in ${project().directory}`}
              onClick={() =>
                void (project().status === "none"
                  ? open(project())
                  : openAttention(project()))}
            >
              <StatusLight
                state={entities() ? lamp(entities()!, key()) : "none"}
                dependencies={project().dependencies}
              />
            </button>
          </TreeIcon>
        }
        action={{
          class: "otk-project-open",
          "aria-label": `Open project ${name()}${
            project().parentLabel ? ` in ${project().parentLabel}` : ""
          }${duplicate() ? ` on ${project().label}` : ""}${
            project().annotation ? `, ${project().annotation}` : ""
          }`,
          title: `${metaList([project().directory, project().label])}${
            projectGroup(project()) === "discovered"
              ? ""
              : ` - ${
                project().status === "none" ? "No known activity" : lampLabel()
              }`
          }${project().annotation ? `, ${project().annotation}` : ""}`,
          onClick: () => void open(project()),
        }}
        avatar={project().artwork === "avatar" &&
            (project().summary?.presentation?.name ||
              project().summary?.presentation?.color)
          ? { name: name(), color: project().summary?.presentation?.color }
          : undefined}
        label={
          <span class="otk-project-name-line">
            <span
              class="otk-project-name"
              data-unread={project().unread ? "true" : "false"}
            >
              {name()}
            </span>
            <Show when={project().inactive && project().parentLabel}>
              <ChromeMeta
                class="otk-project-parent otk-control-label otk-control-grow"
                title={project().topology?.canonicalRoot}
              >
                {project().parentLabel}
              </ChromeMeta>
            </Show>
            <Show when={duplicate()}>
              <ChromeMeta
                class="otk-project-machine otk-control-label otk-control-grow"
                title={project().label}
              >
                {project().label}
              </ChromeMeta>
            </Show>
          </span>
        }
        meta={
          <Show when={!collapsed()}>
            <div class="otk-project-trailing">
              <Show when={(project().source ?? "tracked") === "tracked"}>
                <ChromeMeta
                  class="otk-project-visit"
                  title="Availability and time since last visit"
                >
                  <Show
                    when={project().annotation}
                    fallback={
                      <Show when={project().visit}>
                        {(visit) => <TimeText time={visit()} />}
                      </Show>
                    }
                  >
                    <span class="otk-project-availability">
                      <MetaText
                        items={[project().annotation, project().visit]}
                      />
                    </span>
                  </Show>
                </ChromeMeta>
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
        }
        feedback={
          <Show when={rowError()}>
            <div
              id={rowErrorID}
              class="otk-project-error"
            >
              <FeedbackStatus compact feedback={errorFeedback(rowError())} />
            </div>
          </Show>
        }
      />
    );
  }
  const rootContext = contextTarget(() => ({
    kind: "projects",
    area: true,
    data: undefined,
  }));
  return (
    <SidebarRail
      ref={(element) => {
        rootContext(element);
        orderInput(element);
      }}
      class="otk-project-inbox"
      label="Projects"
      side="left"
      collapsed={collapsed()}
      width={width()}
      bodyClass="otk-inbox-scroll"
      header={
        <div class="otk-inbox-brand">
          <div class="otk-inbox-identity">
            <Show when={!collapsed()}>{props.history}</Show>
            <strong>OTK</strong>
          </div>
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
        <div class="otk-inbox-leading">
          <Show when={collapsed()}>{props.history}</Show>
          <nav class="otk-inbox-commands" aria-label="Search">
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
        </div>
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
          <div
            class={["otk-server-connections", {
              "has-status": !collapsed() &&
                props.servers.some((server) => !!connectionFeedback(server)),
            }]}
            aria-label="Server connections"
          >
            <For each={props.servers} keyed={(s) => s.id}>
              {(s) => (
                <section class="otk-server-connection">
                  <ConnectionBadge
                    sidecar={s()}
                    label={!collapsed()}
                    status={!collapsed()}
                    compact
                    onSettings={() => void commands.run("settings.open")}
                  />
                </section>
              )}
            </For>
          </div>
          <Show when={error()}>
            <FeedbackStatus
              class="otk-inbox-error"
              compact
              feedback={errorFeedback(error())}
            />
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
        <SectionHeader
          sidebar
          class="otk-discovered-section"
          headerClass="otk-discovered-toggle"
          label="Discovered"
          description={`Discovered projects, ${discovered().length}`}
          count={discovered().length}
          compact={collapsed()}
          open={discoveredOpen()}
          onOpen={(value) =>
            void toggleDiscovered(value).catch((error) =>
              setError(
                failureValue(error, { actionLabel: "Saving project layout" }),
              )
            )}
        />
        <DisclosureFeedback
          disclosure={discoveredDisclosure}
          actionLabel="Saving project tree"
          class="otk-project-disclosure-error"
        />
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
        <SectionHeader
          sidebar
          class="otk-inactive-section"
          headerClass="otk-inactive-toggle"
          label="Inactive"
          count={inactiveRows().length}
          open={inactiveOpen()}
          onOpen={(value) =>
            void inactiveDisclosure.set(value).catch((error) =>
              setError(
                failureValue(error, {
                  actionLabel: "Changing inactive projects",
                }),
              )
            )}
        />
        <Show when={inactiveOpen()}>
          <section aria-label="Inactive projects" class="otk-inactive-projects">
            <Branches projects={inactiveRows()} />
          </section>
        </Show>
      </Show>
      <Show when={collapsed()}>
        <Branches projects={inactiveRows()} />
      </Show>
      <Show when={!collapsed() && !props.projects.length}>
        <EmptyState>Add a project to get started.</EmptyState>
      </Show>
    </SidebarRail>
  );
}
