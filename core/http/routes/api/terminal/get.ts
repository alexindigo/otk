// SPDX-License-Identifier: LGPL-3.0-only
import { type Handler, HttpError } from "@pathfinder/pathfinder";
import "../../../app.ts";
const handler: Handler = (request, { app }) => {
  if (!app.terminals) {
    throw new HttpError(404, { code: "terminal-unavailable" });
  }
  const terminals = app.terminals;
  const upgrade = request.upgrade({}, { idleTimeout: 0 });
  upgrade.socket.then((socket) => terminals.accept(socket));
  return upgrade.response;
};
export default handler;
