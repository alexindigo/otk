// SPDX-License-Identifier: LGPL-3.0-only
import type { Handler } from "@pathfinder/pathfinder";
import "../../../app.ts";
const handler: Handler = (_request, { app }) =>
  Response.json({ ok: true }, {
    headers: { "Set-Cookie": app.auth.cookie("", true) },
  });
export default handler;
