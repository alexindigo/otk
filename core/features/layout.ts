// SPDX-License-Identifier: LGPL-3.0-only
import { isProjectLocation, type Preferences } from "@otk/protocol";
import type { Prefs } from "@otk/store";
import type { RpcRegistry } from "../ws/registry.ts";

/** Field intents merge at the authoritative owner, never against view props. */
export function register(rpc: RpcRegistry, prefs: Prefs<Preferences>): void {
  rpc.register("layout.patch", {
    params: (patch) => patch,
    // No await between reading and saving: other gestures/tabs cannot interleave.
    // Prefs validates the complete result before persistence or broadcast.
    handler: (_ctx, patch) =>
      prefs.set("shellLayout", { ...prefs.get().shellLayout, ...patch }),
  });
  // A project-location intent merges at the same persisted layout owner. An old
  // browser snapshot must never replace another project's newer location.
  rpc.register("layout.location", {
    params: (value) => {
      if (!isProjectLocation(value)) {
        throw new Error("Invalid project location");
      }
      return value;
    },
    handler: (_ctx, location) => {
      const layout = prefs.get().shellLayout;
      return prefs.set("shellLayout", {
        ...layout,
        projectLocations: [
          ...(layout.projectLocations ?? []).filter((p) =>
            p.sidecarId !== location.sidecarId ||
            p.directory !== location.directory
          ),
          ...(location.sessionID ? [location] : []),
        ],
      });
    },
  });
}
