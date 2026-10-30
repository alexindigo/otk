// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
import "../../../app.ts";
import { bootstrapAdmission } from "../../../bootstrap-route.ts";
const handler: Handler = (request, { app }) =>
  bootstrapAdmission(app.bootstrap, "bootstrap.logout", request._raw);
export default handler;
