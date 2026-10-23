// SPDX-License-Identifier: LGPL-3.0-only
import WorkLog from "../../components/WorkLog.tsx";
import Settings from "../../components/Settings.tsx";
import RevertBanner from "../../components/RevertBanner.tsx";
import Sidebar from "../../components/Sidebar.tsx";
export default function Scene() {
  return (
    <div class="style-columns">
      <section class="style-panel" id="work">
        <h2>Independent work log</h2>
        <WorkLog time={{ start: 0, end: 4200 }}>
          <p>Owned work content</p>
        </WorkLog>
        <RevertBanner
          revert={{
            messageID: "reverted",
            messageCount: 2,
            files: [{ path: "src/owner.ts", additions: 3, deletions: 1 }],
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
