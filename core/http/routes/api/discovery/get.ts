// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
import { PROTOCOL_VERSION, SIDECAR_VERSION } from "@otk/protocol";
import { allowedOrigin } from "../../../../auth/middleware.ts";
import "../../../app.ts";

const handler: Handler = (request, { app }) =>
  Response.json({
    product: "otk",
    protocol: PROTOCOL_VERSION,
    version: SIDECAR_VERSION,
    originAllowed: allowedOrigin(request._raw, app.cfg),
    signIn: app.auth.setupRequired
      ? "setup"
      : app.auth.local
      ? "login"
      : "none",
  }, { headers: { "Cache-Control": "no-store" } });

export default handler;
