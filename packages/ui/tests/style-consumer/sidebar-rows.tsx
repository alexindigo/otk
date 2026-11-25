// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import { age } from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";
import ProjectInbox, {
  type ProjectRow,
} from "../../components/ProjectInbox.tsx";
import "./sidebar-rows.css" with { type: "text" };

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
  visit: age(0, 3_600_000),
  ageing: 0,
  inactive: false,
  added: true,
  order: 0,
  lastVisit: 0,
  artwork: "avatar",
  ...extra,
});
const root = project("atmosphera", {
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
  return (
    <div class="sidebar-row-scene">
      <ProjectInbox
        projects={[
          root,
          checkout("atmosphera.branch"),
          checkout("atmosphera.archived", {
            archived: true,
            group: "archived",
            availability: "removed",
            annotation: "removed",
          }),
          project("ndash"),
          project("aerial-lock"),
          project("airgraph"),
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
        onProjectCollapse={(project, collapsed) => {
          setPrefs((p) => ({
            ...p,
            shellLayout: {
              ...p.shellLayout,
              projectCollapsed: {
                ...p.shellLayout.projectCollapsed,
                [JSON.stringify([project.sidecarId, project.directory])]:
                  collapsed,
              },
            },
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
