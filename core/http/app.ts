// SPDX-License-Identifier: LGPL-3.0-only
import type { AuthState } from "../auth/state.ts";
import type { ServiceConfig } from "../config/schema.ts";
import type { Connections } from "../ws/connections.ts";
import type { Harness } from "@otk/harness";
declare module "@pathfinder/pathfinder" {
  interface App {
    cfg: ServiceConfig;
    auth: AuthState;
    connections: Connections;
    backend: Harness;
    staticRoot: string;
  }
}
