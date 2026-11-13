// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
import "../../../app.ts";
import { bootstrapAdmission } from "../../../bootstrap-route.ts";
import { PUBLIC_DEFAULTS } from "../../../../config/public-defaults.ts";
const handler: Handler = async (request, { app }) =>
  request.headers.has("X-OTK-Request")
    ? await bootstrapAdmission(app.bootstrap, "bootstrap.session", request._raw)
    : ({
      authenticated: await app.auth.authenticated(request._raw),
      setupRequired: app.auth.setupRequired,
      authType: app.cfg.auth.type,
      defaults: PUBLIC_DEFAULTS,
    });
export default handler;
