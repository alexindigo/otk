// SPDX-License-Identifier: LGPL-3.0-only
import { type Handler, HttpError } from "@pathfinder/pathfinder";
import "../../../app.ts";
import { object, text } from "../../../../ws/params.ts";
const handler: Handler = async (request, { app }) => {
  if (app.auth.setupRequired) {
    throw new HttpError(503, { code: "setup_required" });
  }
  if (!app.auth.local) return { ok: true };
  try {
    const input = object(await request.body.json());
    const token = await app.auth.local.login(
      text(input, "username")!,
      text(input, "password")!,
    );
    return Response.json({ ok: true }, {
      headers: { "Set-Cookie": app.auth.cookie(token) },
    });
  } catch {
    throw new HttpError(401, {
      code: "credentials",
      message: "Incorrect login credentials",
    });
  }
};
export default handler;
