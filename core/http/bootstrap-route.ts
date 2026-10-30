// SPDX-License-Identifier: LGPL-3.0-only
import { requestRef } from "@otk/protocol";
import type { BootstrapRequests } from "./bootstrap.ts";
import { object } from "../ws/params.ts";

const invalid = () =>
  Response.json({
    t: "request.rejected",
    error: {
      code: "request.invalid",
      retry: "new-intent",
      diagnosticID: crypto.randomUUID(),
    },
  }, { status: 400, headers: { "Cache-Control": "no-store" } });
/** Envelope parsing only; all lifetime, authorization and outcomes stay at their owners. */
export async function bootstrapAdmission(
  service: BootstrapRequests,
  method: string,
  request: Request,
): Promise<Response> {
  let ref, input;
  try {
    if (request.method === "GET") {
      ref = requestRef(JSON.parse(request.headers.get("X-OTK-Request")!), true);
      input = null;
    } else {
      const body = object(await request.json());
      ref = requestRef(body.ref, true);
      input = body.input;
    }
  } catch {
    return invalid();
  }
  return await service.admit(
    method,
    request,
    ref,
    input,
    request.headers.get("X-OTK-Receipt") ?? "",
  );
}
export async function bootstrapEvents(
  service: BootstrapRequests,
  request: Request,
): Promise<Response> {
  let ref, after;
  try {
    const body = object(await request.json());
    ref = requestRef(body.ref, true);
    after = Number(body.after);
  } catch {
    return invalid();
  }
  return await service.events(
    request,
    ref,
    after,
    request.headers.get("X-OTK-Receipt") ?? "",
  );
}
