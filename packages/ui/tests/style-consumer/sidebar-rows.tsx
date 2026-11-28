// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import { age, createDisclosures } from "@otk/client";
import { solidState } from "../../state/binding.ts";
import { DEFAULT_PREFS, projectLayoutKey } from "@otk/protocol";
import ProjectInbox, {
  type ProjectRow,
} from "../../components/ProjectInbox.tsx";
import "./sidebar-rows.css" with { type: "text" };

const fixtureTimer = (
  now: number,
) => ({ kind: "attention", tone: "default", time: age(0, now) } as const);
const project = (
  name: string,
  extra: Partial<ProjectRow> = {},
): ProjectRow => ({
  directory: `/projects/${name}`,
  sidecarId: "local",
  label: "This server",
  sessionIDs: "",
  sessionCount: 0,
  status: "finished",
  unread: false,
  timer: fixtureTimer(3_600_000),
  ageing: 0,
  inactive: false,
  added: true,
  lastVisit: 0,
  artwork: "avatar",
  ...extra,
});
const root = project("atmosphera", {
  timer: fixtureTimer(480_000),
  topology: {
    repoID: "atmosphera",
    canonicalRoot: "/projects/atmosphera",
    leafDirectory: "/projects/atmosphera",
  },
  summary: {
    directory: "/projects/atmosphera",
    status: "finished",
    sessionCount: 1,
    unseenCount: 0,
    lastActivity: 0,
    authority: "current",
    presentation: { id: "atmosphera", name: "atmosphera", color: "#008daa" },
  },
});
const checkout = (name: string, extra: Partial<ProjectRow> = {}) =>
  project(name, {
    artwork: "none",
    level: "worktree",
    depth: 1,
    topology: {
      repoID: "atmosphera",
      canonicalRoot: root.directory,
      leafDirectory: `/projects/${name}`,
      parentDirectory: root.directory,
    },
    ...extra,
  });
export default function SidebarRows() {
  const params = new URL(location.href).searchParams;
  const [prefs, setPrefs] = createSignal({
    ...DEFAULT_PREFS,
    shellLayout: {
      ...DEFAULT_PREFS.shellLayout,
      leftWidth: Number(params.get("width") ?? 297.96484375),
      leftCollapsed: params.get("collapsed") === "1",
    },
  });
  const [selected, setSelected] = createSignal({
    sidecarId: "local",
    directory: "/projects/ndash",
  });
  const tree = createDisclosures({
    factory: solidState,
    durable: {
      projectBranch: {
        read: ({ scope: sidecarId, id: directory }) =>
          !prefs().shellLayout.projectCollapsed
            ?.[projectLayoutKey({ sidecarId, directory })],
        save: ({ scope: sidecarId, id: directory }, open) => {
          setPrefs((p) => ({
            ...p,
            shellLayout: {
              ...p.shellLayout,
              projectCollapsed: {
                ...p.shellLayout.projectCollapsed,
                [projectLayoutKey({ sidecarId, directory })]: !open,
              },
            },
          }));
          return Promise.resolve();
        },
      },
      discovered: {
        read: () => !prefs().shellLayout.discoveredCollapsed,
        save: (_, open) => {
          setPrefs((p) => ({
            ...p,
            shellLayout: { ...p.shellLayout, discoveredCollapsed: !open },
          }));
          return Promise.resolve();
        },
      },
    },
  });
  return (
    <div class="sidebar-row-scene">
      <ProjectInbox
        disclosure={tree}
        projects={[
          root,
          checkout("atmosphera.branch"),
          checkout("atmosphera.archived", {
            archived: true,
            group: "archived",
            availability: "removed",
            annotation: "removed",
          }),
          project("ndash", { timer: fixtureTimer(15 * 3_600_000) }),
          project("aerial-lock", { timer: fixtureTimer(52 * 60_000) }),
          project("airgraph", { timer: fixtureTimer(52 * 3_600_000) }),
          project("communico", { timer: fixtureTimer(0) }),
          project("inactive", { inactive: true, group: "inactive" }),
          project("discovered", { source: "template", group: "discovered" }),
        ]}
        duplicateName={() => false}
        servers={[]}
        selected={selected()}
        prefs={prefs()}
        ready
        onOpen={setSelected}
        onInactive={() => Promise.resolve()}
        onLayout={(patch) => {
          setPrefs((p) => ({
            ...p,
            shellLayout: { ...p.shellLayout, ...patch },
          }));
          return Promise.resolve();
        }}
      />
      <section class="sidebar-row-context">
        <h2>Sidebar row layout</h2>
        <p>Projects, checkouts and section headers share their column edges.</p>
      </section>
    </div>
  );
}
