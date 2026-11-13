// SPDX-License-Identifier: LGPL-3.0-only
import { isProjectLocation, type Preferences } from "@otk/protocol";
import type { Prefs } from "@otk/store";
import type { RpcRegistry } from "../ws/registry.ts";
import { localExecution, localWrite } from "../requests/policies.ts";
import { preferencesReceipt } from "./prefs.ts";
import type { NavigationDefault } from "./navigation-default.ts";
import { readExecution } from "../requests/policies.ts";
import { sessionID, text } from "../ws/params.ts";
import { projectPath } from "./project-scan.ts";

/** Field intents merge at the authoritative owner, never against view props. */
export function register(
  rpc: RpcRegistry,
  prefs: Prefs<Preferences>,
  navigation?: NavigationDefault,
): void {
  if (navigation) {
    rpc.register("navigation.default", {
      execution: readExecution((p: { directory: string }) => ({
        directory: p.directory,
      })),
      params: (p) => ({
        directory: projectPath(text(p, "directory")!),
        preferred: sessionID(p, "preferred", true),
      }),
      handler: (ctx, p) =>
        navigation.resolve(ctx.harness.core, p, ctx.execution?.signal),
    });
  }
  const receipt = preferencesReceipt(prefs.options);
  rpc.register("layout.patch", {
    execution: localExecution(
      () => ({ resource: "layout" }),
      receipt,
    ),
    params: (patch) => patch,
    // No await between reading and saving: other gestures/tabs cannot interleave.
    // Prefs validates the complete result before persistence or broadcast.
    handler: (ctx, patch) =>
      localWrite(
        ctx,
        (tx) =>
          prefs.set(
            "shellLayout",
            { ...prefs.get().shellLayout, ...patch },
            tx,
          ),
        receipt,
      ),
  });
  // A project-location intent merges at the same persisted layout owner. An old
  // browser snapshot must never replace another project's newer location.
  rpc.register("layout.location", {
    execution: localExecution(
      (location: { directory: string }) => ({
        directory: location.directory,
        resource: "layout",
      }),
      receipt,
    ),
    params: (value) => {
      if (!isProjectLocation(value)) {
        throw new Error("Invalid project location");
      }
      return value;
    },
    handler: (ctx, location) =>
      localWrite(ctx, (tx) => {
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
        }, tx);
      }, receipt),
  });
}
