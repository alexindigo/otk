// SPDX-License-Identifier: LGPL-3.0-only
import {
  releaseTerminalBoxes,
  type SidecarConnection,
  TerminalSocket,
} from "@otk/client";

const sockets = new WeakMap<SidecarConnection, TerminalSocket>();
export function terminalSocketFor(
  connection: SidecarConnection,
): TerminalSocket {
  let socket = sockets.get(connection);
  if (!socket) sockets.set(connection, socket = new TerminalSocket(connection));
  return socket;
}

/** Shell connection ownership, independent of the mounted panel's lifetime. */
export function createTerminalConnectionOwner() {
  let connections = new Set<SidecarConnection>();
  const release = (connection: SidecarConnection) => {
    sockets.get(connection)?.stop();
    sockets.delete(connection);
    releaseTerminalBoxes(connection);
  };
  return {
    update(next: SidecarConnection[]) {
      const retained = new Set(next);
      for (const connection of connections) {
        if (!retained.has(connection)) release(connection);
      }
      connections = retained;
    },
    stop() {
      for (const connection of connections) release(connection);
      connections.clear();
    },
  };
}
