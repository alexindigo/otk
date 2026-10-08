// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
import "../../../app.ts";
const handler: Handler = async (request, { app }) => ({
  authenticated: await app.auth.authenticated(request._raw),
  setupRequired: app.auth.setupRequired,
  authType: app.cfg.auth.type,
});
export default handler;
