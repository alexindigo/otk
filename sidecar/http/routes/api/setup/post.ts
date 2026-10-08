// SPDX-License-Identifier: LGPL-3.0-only
import { type Handler, HttpError } from "@pathfinder/pathfinder";
import "../../../app.ts";
import { object, text } from "../../../../ws/rpc.ts";
const handler: Handler = async (request, { app }) => {
  if (!app.auth.setupRequired) {
    throw new HttpError(409, { code: "already_configured" });
  }
  try {
    const input = object(await request.body.json());
    await app.auth.setup({
      type: text(input, "type")!,
      username: text(input, "username", true),
      password: text(input, "password", true),
    });
    return { ok: true };
  } catch (e) {
    throw new HttpError(
      (e as Error).message === "already_configured" ? 409 : 400,
      { code: "setup", message: (e as Error).message },
    );
  }
};
export default handler;
