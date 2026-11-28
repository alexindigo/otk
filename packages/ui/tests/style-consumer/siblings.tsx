// SPDX-License-Identifier: LGPL-3.0-only
import WorkStrip from "../../components/WorkStrip.tsx";
import { workRuns } from "../../components/work-log.ts";
import Settings from "../../components/Settings.tsx";
import RevertGroup from "../../components/RevertGroup.tsx";
import { DEFAULT_PREFS } from "@otk/protocol";
import Sidebar from "../../components/Sidebar.tsx";
export default function Scene() {
  return (
    <div class="style-columns">
      <section class="style-panel" id="work">
        <h2>Independent work log</h2>
        <WorkStrip
          runs={workRuns({
            parts: [{ kind: "meta", id: "check" }],
            terminal: true,
            now: 2000,
            presentation: () => ({
              work: { start: 1000, end: 2000 },
              run: { label: "Check output" },
            }),
          })}
          shown={false}
          action={() => ({
            availability: () => ({ available: true }),
            subscribe: () => () => {},
            run: () => Promise.resolve({ kind: "shown" }),
          })}
        />
        <RevertGroup
          group={{
            key: "revert:boundary",
            title: "Reverted",
            members: [],
            revision: 0,
          }}
          prefs={DEFAULT_PREFS}
          onOpenChild={() => {}}
          state={{
            phase: "saved",
            record: {
              boundaryID: "boundary",
              messageIDs: ["boundary", "reply"],
              prompt: {
                input: "Boundary prompt",
                mode: "normal",
                parts: [],
                time: 1,
              },
              files: [{ path: "src/owner.ts", additions: 3, deletions: 1 }],
            },
          }}
        />
      </section>
      <section class="style-panel" id="settings">
        <Settings
          sidecars={[]}
          onAdd={() => Promise.resolve()}
          onRemove={() => {}}
          onLogin={() => Promise.resolve()}
          onSetup={() => Promise.resolve()}
          onClose={() => {}}
        />
      </section>
      <section class="style-panel" id="sidebar">
        <Sidebar
          sidecars={[]}
          entries={[]}
          onOpen={() => {}}
          onCreate={() => {}}
          onSettings={() => {}}
        />
      </section>
    </div>
  );
}
