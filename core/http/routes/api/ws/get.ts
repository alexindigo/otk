// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
import "../../../app.ts";
const handler: Handler = (request, { app }) => {
  // The OTK protocol owns the independent 20-second ping / 60-second silence timers.
  const upgrade = request.upgrade({}, { idleTimeout: 0 });
  upgrade.socket.then((socket) => app.connections.accept(socket));
  return upgrade.response;
};
export default handler;
