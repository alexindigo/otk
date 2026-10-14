// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
import "../../../app.ts";
import { PROTOCOL_VERSION, SIDECAR_VERSION } from "@otk/protocol";
const handler: Handler = (_request, { app }) => ({
  ok: true,
  version: SIDECAR_VERSION,
  protocol: PROTOCOL_VERSION,
  harness: { kind: app.backend.core.kind, version: app.backend.core.version },
});
export default handler;
