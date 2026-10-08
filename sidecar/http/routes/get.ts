// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
import "../app.ts";
import { staticResponse } from "../static.ts";
const handler: Handler = (request, context) =>
  staticResponse(request.path, context.app);
export default handler;
