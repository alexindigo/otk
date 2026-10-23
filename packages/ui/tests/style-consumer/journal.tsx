// SPDX-License-Identifier: LGPL-3.0-only
import type { PermissionRequest } from "@otk/protocol";
import PermissionSummary from "../../components/PermissionSummary.tsx";
import PermissionActivity from "../../components/PermissionActivity.tsx";
const request: PermissionRequest = {
  id: "request",
  sessionID: "session",
  kind: "edit",
  title: "Edit files",
  time: 1720000000000,
  patterns: ["src/*", "tests/*"],
  alwaysPatterns: [],
  detail: {
    kind: "edit",
    files: [{
      path: "src/owner.ts",
      additions: 3,
      deletions: 1,
      status: "modified",
      hunks: [],
    }, {
      path: "tests/owner.ts",
      additions: 8,
      deletions: 0,
      status: "added",
      hunks: [],
    }],
  },
};
export default function Scene() {
  return (
    <div class="style-columns">
      <section class="style-panel" id="summary">
        <h2>Independent summary</h2>
        <PermissionSummary request={request} />
      </section>
      <section class="style-panel" id="activity">
        <h2>Activity summary</h2>
        <PermissionActivity
          title={() => "Captured session"}
          onMore={() => Promise.resolve()}
          onRetry={() => Promise.resolve()}
          value={{
            loading: false,
            entries: [{
              id: 1,
              request,
              source: "manual",
              reply: "once",
              time: 1720000000000,
              outcome: "confirmed",
            }],
          }}
        />
      </section>
    </div>
  );
}
