// SPDX-License-Identifier: LGPL-3.0-only
import {
  type Disclosures,
  type DisclosureState,
  errorFeedback,
  type FailureValue,
  failureValue,
  type ProjectBranch,
  projectBranchPresentation,
  projectGroup,
  projectTree,
  treePaths,
} from "@otk/client";
import { archiveEntityID, entityKey, UNKNOWN_REPOSITORY } from "@otk/protocol";
import { type EntityStateStore, label as stateLabel, lamp } from "@otk/client";
import FeedbackStatus from "./FeedbackStatus.tsx";
import { EmptyState } from "./View.tsx";
import "./ProjectInbox.css" with { type: "text" };
import SidebarRow, {
  SidebarFeedback,
  SidebarFrame,
  SidebarLampAction,
} from "./SidebarRow.tsx";
import { ControlIcon } from "./ControlValue.tsx";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import {
  checkoutLabel,
  projectLabel,
  type ProjectProjectionRow,
  type ProjectRename,
  type ProjectRenameTarget,
  type ProjectSelection,
  type SidecarState,
} from "@otk/client";
import {
  type Preferences,
  type ProjectMove,
  type ProjectMoveTarget,
  SHELL_WIDTHS,
  type ShellLayout,
} from "@otk/protocol";
import StatusLight from "./StatusLight.tsx";
import ConnectionBadge from "./ConnectionBadge.tsx";
import { createResize } from "./resize.ts";
import { createRowReorder } from "./row-reorder.ts";
import { acquireViewport } from "./viewport.ts";
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
  selectionFocus,
  useCommandPorts,
} from "../keyboard/context.tsx";
import CommandMenu from "./CommandMenu.tsx";
import SidebarRail from "./SidebarRail.tsx";
import { contextTarget } from "./context-target.ts";
import { TreeNode } from "./Tree.tsx";
import ChromeMeta, {
  MetaItem,
  metaList,
  SectionHeader,
} from "./ChromeMeta.tsx";
import SidebarTimer from "./SidebarTimer.tsx";
import DisclosureFeedback from "./DisclosureFeedback.tsx";
import { connectionFeedback } from "./connection-light.ts";
import TitleEditor, { TitleFeedback } from "./TitleEditor.tsx";
export interface ProjectRow extends ProjectProjectionRow {
  sidecarId: string;
  label: string;
  otkProjectID?: string;
}
export default function ProjectInbox<T extends ProjectRow>(props: {
  disclosure: Disclosures;
  projects: T[];
  duplicateName(name: string): boolean;
  projectLabel?(sidecarId: string, directory: string): string;
  projectRename?: ProjectRename;
  canRename?(row: ProjectRow): boolean;
  servers: SidecarState[];
  selected?: ProjectSelection;
  prefs: Preferences;
  ready: boolean;
  history?: import("solid-js").Element;
  collapseToggle?: import("solid-js").Element;
  ref?(element: HTMLElement): void;
  onOpen(project: ProjectSelection): void;
  onAttention?(project: ProjectSelection): void;
  onInactive(project: ProjectSelection, value: boolean): Promise<void>;
  onMove?(id: string, move: ProjectMove): Promise<void>;
  onLayout(patch: Partial<ShellLayout>): Promise<void>;
  /** The connection's entity states; standalone consumers present rows'. */
  entities?(server: string): EntityStateStore;
}): import("solid-js").Element {
  const disclosure = props.disclosure;
  const inactiveDisclosure = disclosure.bind("inactive", {
    scope: "",
    id: "inactive",
  });
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
  const renameTarget = (
    project: ProjectRow,
  ): ProjectRenameTarget | undefined => {
    const projectID = project.summary?.presentation?.id;
    if (!projectID) return;
    return {
      sidecarId: project.sidecarId,
      directory: project.directory,
      projectID,
      title: project.displayName ??
        checkoutLabel(project.directory, project.summary),
    };
  };
  const renameRow = (input: ProjectSelection) => {
    if (!props.ready || !props.projectRename) return;
    const row = props.projects.find((p) =>
      p.sidecarId === input.sidecarId && p.directory === input.directory
    );
    if (row && props.canRename?.(row)) return row;
  };
  const renameArgs = {
    type: "object" as const,
    properties: {
      sidecarId: { type: "string" as const },
      directory: { type: "string" as const },
    },
  };
  const captureReturn = () => ports.keyboard?.focusOwner.returnLease();
  let restoreRename: ReturnType<typeof captureReturn>;
  ownedAction("project.rename", (input: ProjectSelection) => {
    const row = renameRow(input), target = row && renameTarget(row);
    if (target) {
      restoreRename = captureReturn();
      props.projectRename?.start(target);
    }
  }, {
    arguments: renameArgs,
    context: { kind: "project", title: () => "Rename", order: -20 },
    enabled: (_ctx, input) =>
      !!input && props.projectRename?.state.pendingTitle === undefined &&
      !!renameRow(input),
  });
  const resetRow = (input: ProjectSelection) => {
    const row = renameRow(input);
    return row?.summary?.presentation?.name ? row : undefined;
  };
  ownedAction("project.resetName", async (input: ProjectSelection) => {
    const row = resetRow(input), target = row && renameTarget(row);
    if (target) await props.projectRename?.reset(target);
  }, {
    arguments: renameArgs,
    context: { kind: "project", title: () => "Reset name", order: -10 },
    enabled: (_ctx, input) => !!input && !!resetRow(input),
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
  type Section = "Active" | "Inactive" | "Discovered";
  const roots = (section: Section) =>
    section === "Active"
      ? liveRows()
      : section === "Inactive"
      ? projectTree(inactiveRows())
      : projectTree(
        discovered().filter((p) => discoveredOpen() || p.status !== "none"),
      );
  const headings = new Map<string, HTMLDivElement>();
  const focusButtons = new Map<string, HTMLButtonElement>();
  const rowErrors = new Map<string, (cause: unknown) => void>();
  const [orderStatus, setOrderStatus] = createSignal("");
  let scroller: HTMLElement | undefined;
  let scrollLease: ReturnType<typeof acquireViewport> | undefined;
  onCleanup(() => scrollLease?.release());
  const sections = (): Section[] => ["Active", "Discovered", "Inactive"];
  const reorderable = (node: ProjectBranch<ProjectRow>) =>
    !!node.project.otkProjectID &&
    node.project.level !== "worktree" && !node.project.archived;
  const sectionOf = (key: string) =>
    sections().find((section) =>
      roots(section).some((node) => node.key === key && reorderable(node))
    );
  const focusable = (key: string) => focusButtons.get(key);
  const focusedRoot = () =>
    [...headings.keys()].find((key) =>
      focusable(key) === document.activeElement
    );
  const selectionKey = (input: { directory?: string; sidecarId?: string }) =>
    input.directory && input.sidecarId
      ? JSON.stringify([input.sidecarId, input.directory])
      : focusedRoot();
  const peers = (section: Section, sidecar: string) =>
    roots(section).filter((node) =>
      node.project.sidecarId === sidecar && reorderable(node)
    );
  async function commitMove(
    key: string,
    target: ProjectMoveTarget,
    pointer = false,
  ) {
    const section = sectionOf(key);
    const row = section &&
      roots(section).find((node) => node.key === key)?.project;
    if (!section || !row?.otkProjectID || !props.onMove) return;
    const anchor = "before" in target ? target.before : target.after;
    if (
      !peers(section, row.sidecarId).some((node) =>
        node.project.otkProjectID === anchor
      )
    ) return;
    const origin = focusable(key);
    const restore = document.activeElement === origin
      ? ports.keyboard?.focusOwner.returnLease(
        !pointer && origin?.matches(":focus-visible"),
      )
      : undefined;
    setOrderStatus("");
    await props.onMove(row.sidecarId, { id: row.otkProjectID, ...target });
    queueMicrotask(() => {
      restore?.(focusable(key), origin);
      const nodes = roots(section).filter(reorderable);
      const index = nodes.findIndex((node) => node.key === key);
      if (index >= 0) {
        setOrderStatus(
          `${
            row.displayName ?? checkoutLabel(row.directory, row.summary)
          } moved to position ${index + 1} of ${nodes.length} in ${section}`,
        );
      }
    });
  }
  type Step = { sidecarId?: string; directory?: string; delta: -1 | 1 };
  const neighbor = (input: Step) => {
    const key = selectionKey(input), section = key && sectionOf(key);
    const anchor = section && roots(section).find((node) => node.key === key);
    if (!key || !section || !anchor || !props.ready || !props.onMove) return;
    const candidates = peers(section, anchor.project.sidecarId);
    const next = candidates[
      candidates.findIndex((node) => node.key === key) + input.delta
    ];
    if (next?.project.otkProjectID) {
      return { key, id: next.project.otkProjectID };
    }
  };
  const moveCommand = `project.move@${createUniqueId()}`;
  ownedCommand<Step, void>(ports, {
    id: moveCommand,
    name: "project.move",
    scope: "control",
    title: "Move project",
    category: "Controls",
    arguments: {
      type: "object",
      properties: {
        sidecarId: { type: "string", optional: true },
        directory: { type: "string", optional: true },
        delta: { type: "number", enum: [-1, 1] },
      },
    },
    context: {
      kind: "project",
      order: -5,
      group: "position",
      showUnavailable: true,
      arguments: renameArgs,
      items(input) {
        const key = selectionKey(input);
        if (!props.onMove || !key || !sectionOf(key)) return [];
        return ([-1, 1] as const).map((delta) => ({
          key: String(delta),
          title: delta < 0 ? "Move up" : "Move down",
          args: { ...input, delta },
        }));
      },
    },
    availability: (_ctx, input) =>
      input && neighbor(input)
        ? { available: true }
        : { available: false, reason: "No project in that direction" },
    run: async (_ctx, input) => {
      const next = neighbor(input);
      if (next) {
        await commitMove(
          next.key,
          input.delta < 0 ? { before: next.id } : { after: next.id },
        );
      }
    },
  });
  onSettled(() => {
    const keys = ports.keyboard?.keymap;
    if (!keys) return;
    const when = () => !!focusedRoot();
    const up = keys.bind({
      id: "project.moveUp",
      command: moveCommand,
      args: { delta: -1 },
      key: "Alt+ArrowUp",
      ctx: "sidebar",
    }, when);
    const down = keys.bind({
      id: "project.moveDown",
      command: moveCommand,
      args: { delta: 1 },
      key: "Alt+ArrowDown",
      ctx: "sidebar",
    }, when);
    return () => {
      up();
      down();
    };
  });
  const reorder = createRowReorder<Section>({
    items(section) {
      return roots(section).map((node) => ({
        key: node.key,
        id: node.project.otkProjectID ?? "",
        sidecar: node.project.sidecarId,
        element: () => headings.get(node.key),
      }));
    },
    scroller: () => scroller,
    scrollBy: (delta) => {
      if (scroller) scrollLease?.owner.input(scroller.scrollTop + delta);
    },
    move: (key, target) => commitMove(key, target, true),
    menu: (key) => {
      const origin = focusable(key);
      if (!origin) return;
      const { left, top, width, height } = origin.getBoundingClientRect();
      origin.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          composed: true,
          cancelable: true,
          button: 2,
          clientX: left + width / 2,
          clientY: top + height / 2,
        }),
      );
    },
    failure: (key, cause) => rowErrors.get(key)?.(cause),
  });
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
  type BranchRow =
    & {
      key: string;
      depth: number;
      intent: DisclosureState;
    }
    & (
      | { kind: "archive"; repo: ProjectRow }
      | {
        kind: "project";
        node: ProjectBranch<ProjectRow>;
        hasChildren: boolean;
        detachedArchive: boolean;
        archived: boolean;
      }
    );
  function groupRows(root?: ProjectBranch<ProjectRow>, repo?: ProjectRow) {
    const rows: BranchRow[] = [];
    const appendArchive = (repo: ProjectRow, depth: number) => {
      const intent = disclosure.bind("archive", {
        scope: repo.sidecarId,
        id: repository(repo),
      });
      rows.push({
        kind: "archive",
        key: `archive:${repositoryKey(repo)}`,
        repo,
        depth,
        intent,
      });
      if (intent.open() && !collapsed()) {
        for (const child of projectTree(archivedRows(repo))) {
          appendProject(child, depth + 1, undefined, true);
        }
      }
    };
    const appendProject = (
      node: ProjectBranch<ProjectRow>,
      depth: number,
      archive?: ProjectRow,
      archived = false,
    ) => {
      const intent = disclosure.bind("projectBranch", {
        scope: node.project.sidecarId,
        id: node.project.directory,
      });
      const nested = archive?.directory === repository(node.project);
      const archiveCount = archive ? archivedRows(archive).length : 0;
      const presentation = projectBranchPresentation(
        node,
        intent.open(),
        archiveCount,
      );
      rows.push({
        kind: "project",
        key: node.key,
        depth,
        node,
        intent,
        archived,
        hasChildren: presentation.hasChildren &&
          (nested || node.children.length > 0),
        detachedArchive: archiveCount > 0 && !nested,
      });
      for (const child of presentation.children) {
        appendProject(child, depth + 1, undefined, archived);
      }
      if (archive && presentation.archiveVisible) {
        appendArchive(archive, nested ? depth + 1 : depth);
      }
    };
    if (root) appendProject(root, 0, repo);
    else if (repo) appendArchive(repo, 0);
    const paths = treePaths(rows, (row) => row.depth);
    return rows.map((row, index) => ({ ...row, path: paths[index] }));
  }
  function ProjectGroup(
    group: {
      root?: ProjectBranch<ProjectRow>;
      archive?: ProjectRow;
      section?: Section;
    },
  ) {
    const rows = createMemo(() => groupRows(group.root, group.archive));
    return (
      <div
        role="group"
        class={["otk-project-tree otk-sidebar-tree", {
          "is-lifted": !!group.root && reorder.lifted(group.root.key),
          "otk-surface-lifted": !!group.root && reorder.lifted(group.root.key),
        }]}
        data-project-root={group.root?.key}
      >
        <For each={rows()} keyed={(row) => row.key}>
          {(row) => {
            const project = () => {
              const entry = row();
              return entry.kind === "project" ? entry : undefined;
            };
            const archive = () => {
              const entry = row();
              return entry.kind === "archive" ? entry : undefined;
            };
            return (
              <>
                <Show when={project()}>
                  {(entry) => (
                    <ProjectNode
                      item={entry()}
                      section={entry().key === group.root?.key
                        ? group.section
                        : undefined}
                    />
                  )}
                </Show>
                <Show when={archive()}>
                  {(entry) => (
                    <Archive
                      repo={entry().repo}
                      path={entry().path}
                      intent={entry().intent}
                    />
                  )}
                </Show>
              </>
            );
          }}
        </For>
      </div>
    );
  }
  function DropMarker() {
    return (
      <div class="otk-project-drop" aria-hidden="true">
        <span />
      </div>
    );
  }
  function Branches(section: { name: Section }) {
    const nodes = () => roots(section.name);
    const drop = () => reorder.drop(section.name);
    return (
      <div
        data-project-section={section.name}
        class="otk-project-order-section"
      >
        <For each={nodes()} keyed={(node) => node.key}>
          {(node) => (
            <>
              <Show
                when={drop() ===
                  nodes().findIndex((item) => item.key === node().key)}
              >
                <DropMarker />
              </Show>
              <ProjectGroup
                root={node()}
                section={section.name}
                archive={section.name === "Active" &&
                    archiveOwners().get(repositoryKey(node().project))?.key ===
                      node().key
                  ? node().project
                  : undefined}
              />
            </>
          )}
        </For>
        <Show when={drop() === nodes().length}>
          <DropMarker />
        </Show>
      </div>
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
  function Archive(
    section: {
      repo: ProjectRow;
      path: readonly boolean[];
      intent: DisclosureState;
    },
  ) {
    const expanded = () => section.intent.open();
    const setExpanded = (value: boolean) => {
      void section.intent.set(value);
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
    const status = () => lamp(archive(), key());
    const unseenCount = () => {
      const store = archive();
      return store && !store.isStale
        ? store.get(key())?.counts.unseen ?? 0
        : null;
    };
    const description = () =>
      `${label()}, ${projects().length}, ${
        unseenCount() === null
          ? "unseen count unavailable"
          : `${unseenCount()} unseen`
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
      <SectionHeader
        sidebar
        path={section.path}
        hasChildren={!!projects().length}
        class="otk-project-archive otk-archive-tree"
        headerClass="otk-archived-toggle"
        metaClass="otk-archived-count"
        label={unknown() ? "Unknown repository" : "Archived"}
        description={description()}
        count={projects().length}
        compact={collapsed()}
        open={expanded() && !collapsed()}
        onOpen={change}
        attributes={{
          "data-rollup": status(),
          "data-unseen-count": unseenCount(),
        }}
        leading={() => <StatusLight state={status()} />}
      />
    );
  }
  const discoveredDisclosure = disclosure.bind("discovered", {
    scope: "",
    id: "discovered",
  });
  const discoveredOpen = discoveredDisclosure.open;
  const toggleDiscovered = ownedAction(
    "projects.discovered",
    async (value: boolean) => {
      await discoveredDisclosure.set(value);
    },
    { arguments: { type: "boolean" } },
  );
  function ProjectNode(
    row: {
      item: Extract<BranchRow, { kind: "project" }> & { path: boolean[] };
      section?: Section;
    },
  ) {
    const [rowError, setRowError] = createSignal<FailureValue>("");
    const rowErrorID = `project-error-${createUniqueId()}`;
    const node = () => row.item.node;
    const project = () => node().project;
    const reorderKey = node().key;
    const movable = () => !!row.section && reorderable(node());
    onCleanup(() => {
      headings.delete(reorderKey);
      focusButtons.delete(reorderKey);
      rowErrors.delete(reorderKey);
    });
    const renaming = () => {
      const target = renameTarget(project());
      return !!target && !!props.projectRename?.matches(target);
    };
    const editing = () => renaming() && props.projectRename!.editing;
    let root!: HTMLElement;
    let openButton: HTMLButtonElement | undefined;
    const selected = () =>
      props.selected?.sidecarId === project().sidecarId &&
      props.selected?.directory === project().directory;
    const bindFocus = selectionFocus("project", selected, () => openButton);
    createEffect(editing, (active, before) => {
      if (!active && before) {
        const returnFocus = restoreRename;
        queueMicrotask(() => {
          if (!editing()) returnFocus?.(openButton, root);
        });
      }
    });
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
    const status = () => lamp(entities(), key());
    const lampLabel = () => stateLabel(status());
    return (
      <TreeNode
        path={row.item.path}
        class={row.item.archived ? "otk-project-archive" : undefined}
        heading={movable()
          ? {
            "data-project-root": reorderKey,
            "data-defer-touch-menu": reorder.defersTouchMenu(reorderKey)
              ? ""
              : undefined,
            ref: (element: HTMLDivElement) => {
              headings.set(reorderKey, element);
            },
            ...(props.onMove && props.ready
              ? reorder.handlers(row.section!, reorderKey)
              : {}),
          }
          : undefined}
        compact={collapsed()}
        selected={selected()}
        label={`Worktrees in ${project().displayName}`}
        open={row.item.intent.open()}
        hasChildren={row.item.hasChildren}
        showEmptyToggle={row.item.detachedArchive}
        onOpen={(open) => void row.item.intent.set(open)}
        frame={({ class: surface, children }) => (
          <SidebarFrame
            frame={{
              ref: (element) => {
                root = element;
                bindFocus(element);
                contextTarget(target)(element);
                if (movable()) {
                  rowErrors.set(reorderKey, (cause) =>
                    setRowError(
                      failureValue(cause, {
                        actionLabel: "Saving project order",
                      }),
                    ));
                }
              },
              class: `${surface} otk-project-row otk-sidebar-selection${
                project().depth ? " is-subproject" : ""
              }`,
              selected: selected(),
              attributes: {
                "data-project": project().directory,
                "data-server": project().sidecarId,
                "data-project-sessions": project().sessionIDs,
                "data-inactive": project().inactive ? "true" : "false",
                "data-source": project().source,
                "data-group": projectGroup(project()),
                "data-rollup": status(),
                "data-summary-authority": project().summary?.authority,
                "data-project-parent": project().topology?.parentDirectory,
                "data-project-repo": project().topology?.repoID,
                "data-project-availability": project().availability,
                "data-project-archived": project().archived ? "true" : "false",
              },
            }}
          >
            {children}
          </SidebarFrame>
        )}
        node={() => (
          <SidebarLampAction
            label={status() === "none"
              ? `Open project ${name()}`
              : `${lampLabel()}: open session in ${name()}`}
            title={status() === "none"
              ? `Open project ${project().directory}`
              : `${lampLabel()}: open session in ${project().directory}`}
            onClick={() =>
              void (status() === "none"
                ? open(project())
                : openAttention(project()))}
          >
            <StatusLight
              state={status()}
              dependencies={project().dependencies}
            />
          </SidebarLampAction>
        )}
        header={() => (
          <SidebarRow
            editing={editing()}
            mainRef={(element) => {
              openButton = element;
              if (movable()) focusButtons.set(reorderKey, element);
            }}
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
                  : ` - ${lampLabel()}`
              }${project().annotation ? `, ${project().annotation}` : ""}`,
              onClick: () => void open(project()),
            }}
            avatar={project().artwork === "avatar" &&
                (project().summary?.presentation?.name ||
                  project().summary?.presentation?.color)
              ? { name: name(), color: project().summary?.presentation?.color }
              : undefined}
            title={{
              text: name(),
              pending: renaming()
                ? props.projectRename!.state.pendingTitle
                : undefined,
              emphasis: !!project().unread,
              qualifiers: [
                ...(project().inactive && project().parentLabel
                  ? [{
                    text: project().parentLabel!,
                    title: project().topology?.canonicalRoot,
                  }]
                  : []),
                ...(duplicate()
                  ? [{ text: project().label, title: project().label }]
                  : []),
              ],
            }}
            editor={editing()
              ? (
                <TitleEditor
                  owner={props.projectRename!}
                  label="Rename project"
                  feedbackID={rowErrorID}
                />
              )
              : undefined}
            meta={
              <Show
                when={!collapsed() && !editing()}
              >
                <Show
                  when={(project().source ?? "tracked") === "tracked" &&
                    project().annotation}
                >
                  <MetaItem rank={1}>
                    <ChromeMeta
                      class="otk-project-availability"
                      title="Availability"
                    >
                      {project().annotation}
                    </ChromeMeta>
                  </MetaItem>
                </Show>
                <SidebarTimer
                  class="otk-project-visit"
                  value={project().timer}
                />
              </Show>
            }
            control={!collapsed() && !editing()
              ? (
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
              )
              : undefined}
          />
        )}
        feedback={() => (
          <SidebarFeedback>
            <Show
              when={renaming()}
              fallback={
                <Show when={rowError()}>
                  <div
                    id={rowErrorID}
                    class="otk-project-error"
                  >
                    <FeedbackStatus
                      compact
                      feedback={errorFeedback(rowError())}
                    />
                  </div>
                </Show>
              }
            >
              <Show
                when={props.projectRename!.state.invalid ||
                  props.projectRename!.state.error}
              >
                <TitleFeedback
                  owner={props.projectRename!}
                  id={rowErrorID}
                  expanded
                />
              </Show>
            </Show>
            <DisclosureFeedback
              disclosure={row.item.intent}
              actionLabel="Saving project tree"
              class="otk-project-disclosure-error"
            />
          </SidebarFeedback>
        )}
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
        props.ref?.(element);
      }}
      class={`otk-project-inbox${reorder.active() ? " is-reordering" : ""}`}
      label="Projects"
      side="left"
      collapsed={collapsed()}
      width={width()}
      bodyClass="otk-inbox-scroll otk-sidebar-list"
      viewport={(element) => {
        scrollLease?.release();
        scroller = element;
        scrollLease = acquireViewport(element);
      }}
      header={
        <div class="otk-inbox-brand">
          {props.collapseToggle}
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
      <span role="status" aria-live="polite" class="otk-project-order-status">
        {orderStatus()}
      </span>
      <Branches name="Active" />
      <For each={orphanArchives()} keyed={repositoryKey}>
        {(repo) => <ProjectGroup archive={repo()} />}
      </For>
      <Show when={discovered().length}>
        <SectionHeader
          sidebar
          path={[]}
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
          <Branches name="Discovered" />
        </section>
      </Show>
      <Show when={!collapsed() && inactiveRows().length}>
        <SectionHeader
          sidebar
          path={[]}
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
            <Branches name="Inactive" />
          </section>
        </Show>
      </Show>
      <Show when={collapsed()}>
        <Branches name="Inactive" />
      </Show>
      <Show when={!collapsed() && !props.projects.length}>
        <EmptyState>Add a project to get started.</EmptyState>
      </Show>
    </SidebarRail>
  );
}
