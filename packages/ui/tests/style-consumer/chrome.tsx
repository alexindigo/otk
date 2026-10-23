// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import { createTabs } from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";
import ProjectTabs from "../../components/ProjectTabs.tsx";
import ProjectInbox from "../../components/ProjectInbox.tsx";
import Popover from "../../components/surface/Popover.tsx";
const tabs = createTabs(() =>
  Promise.reject(new Error("No promotion expected"))
);
export default function Scene() {
  const [reserve, setReserve] = createSignal(false),
    [collapsed, setCollapsed] = createSignal(false);
  styleTest.reserve = setReserve;
  styleTest.collapse = setCollapsed;
  return (
    <div class="style-chrome">
      <ProjectInbox
        projects={[]}
        entries={[]}
        servers={[{
          id: "local",
          label: "Serving server",
          baseUrl: "",
          status: "connected",
          harness: "connected",
          connectionVersion: 1,
          capabilities: [],
        }]}
        prefs={{
          ...DEFAULT_PREFS,
          shellLayout: {
            ...DEFAULT_PREFS.shellLayout,
            leftCollapsed: collapsed(),
          },
        }}
        ready
        onOpen={() => {}}
        onInactive={() => Promise.resolve()}
        onLayout={() => Promise.resolve()}
      />
      <div>
        <ProjectTabs
          project={{ sidecarId: "local", directory: "/workspace/project" }}
          model={tabs}
          entries={[]}
          inbox={{
            projects: [],
            tasks: [],
            seen: {},
            finishes: {},
            pathTemplates: [],
          }}
          messages={[]}
          exhausted
          ready
          {...{ reserveTrailing: reserve() }}
          onOpen={() => true}
          onEmpty={() => true}
          onCreateSession={() => Promise.resolve()}
          actions={{
            create: () => Promise.reject(new Error("unused")),
            rename: () => Promise.resolve(),
            close: () => Promise.resolve(),
            reorder: () => Promise.resolve(),
            add: () => Promise.resolve(),
            remove: () => Promise.resolve(),
          }}
        />
        <Popover
          label="Slot control"
          trigger="Trigger slot"
          {...{ triggerClass: "consumer-trigger" }}
        >
          <p>Flowing content</p>
        </Popover>
      </div>
    </div>
  );
}
