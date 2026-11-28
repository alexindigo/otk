// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
import "../../../app.ts";

const handler: Handler = (request, { app }) =>
  app.inlineImages?.response(request._raw, app.cfg) ??
    new Response("Not found", { status: 404 });
export default handler;
