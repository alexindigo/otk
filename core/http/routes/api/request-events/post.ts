// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
import "../../../app.ts";
import { bootstrapEvents } from "../../../bootstrap-route.ts";
const handler: Handler = (request, { app }) =>
  bootstrapEvents(app.bootstrap, request._raw);
export default handler;
