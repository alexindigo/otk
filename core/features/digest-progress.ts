// SPDX-License-Identifier: LGPL-3.0-only
import type { DigestBridge } from "../digest/bridge.ts";
import type { FrameSource } from "../ws/connections.ts";

/** Only global scalar progress and this socket's current project cross the wire. */
export function digestProgressSource(
  bridge: Pick<DigestBridge, "progress" | "observeProgress">,
): FrameSource {
  return {
    listen: () => () => {},
    open(view) {
      const frame = (values = bridge.progress()) => ({
        t: "digest.progress" as const,
        values: values.filter((value) =>
          value.directory === undefined || value.directory === view().directory
        ),
      });
      return {
        snapshot: () => frame(),
        listen: (listener) =>
          bridge.observeProgress((values) => listener(frame(values))),
      };
    },
  };
}
