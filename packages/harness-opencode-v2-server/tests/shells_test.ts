// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { type OperationContext, OperationFailure } from "@otk/protocol";
import { V2Client } from "../client.ts";
import { V2Shells } from "../shells.ts";

function info(id: string, sessionID = "ses_owner") {
  return {
    id,
    status: "running",
    metadata: { sessionID },
    time: { started: 1 },
  };
}
Deno.test("V2 shell activity is per running identity, deduplicated and independent of transcript leases", () => {
  const owner = new V2Shells(), location = { directory: "/repo" };
  owner.event({
    type: "shell.created",
    location,
    data: { info: info("sh_a") },
  });
  owner.event({
    type: "session.shell.started",
    location,
    data: { shell: info("sh_a") },
  });
  owner.event({
    type: "shell.created",
    location,
    data: { info: info("sh_b") },
  });
  assertEquals(owner.sessions(), ["ses_owner"]);
  owner.event({ type: "shell.exited", data: { id: "sh_a" } });
  assertEquals(owner.busy("ses_owner"), true);
  owner.event({ type: "shell.deleted", data: { id: "sh_b" } });
  assertEquals(owner.busy("ses_owner"), false);
  assertEquals(
    owner.event({ type: "session.shell.ended", data: { shell: info("sh_a") } }),
    undefined,
  );
});
Deno.test("V2 shell interruption discovers current and original locations, excludes unrelated work and fences each mutation", async () => {
  const owner = new V2Shells(), removed: string[] = [];
  owner.event({
    type: "shell.created",
    location: { directory: "/original" },
    data: { info: info("sh_original") },
  });
  const client = new V2Client(
    { endpoint: { url: "http://localhost:4000" }, pid: 1, version: "2.2.6" },
    1000,
    new AbortController().signal,
    (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/session/ses_owner") {
        return Promise.resolve(
          Response.json({ data: { location: { directory: "/current" } } }),
        );
      }
      if (url.pathname === "/api/shell") {
        return Promise.resolve(
          Response.json({
            data: [
              info(
                url.searchParams.get("location[directory]") === "/original"
                  ? "sh_original"
                  : "sh_current",
              ),
              info("sh_unrelated", "ses_other"),
            ],
          }),
        );
      }
      if (url.pathname.endsWith("/interrupt")) {
        return Promise.resolve(Response.json({ interrupted: false }));
      }
      if (init?.method === "DELETE") {
        removed.push(url.pathname.split("/").at(-1)!);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  );
  let fences = 0;
  await owner.interrupt(client, "opcv2-ses_owner", {
    signal: new AbortController().signal,
    beforeEffect: () => {
      fences++;
      return Promise.resolve();
    },
  } as unknown as OperationContext);
  assertEquals(removed, ["sh_current", "sh_original"]);
  assertEquals(fences, 3);
  assertEquals(owner.busy("ses_other"), false);
});
Deno.test("failed shell inventory cannot erase last-good running activity", async () => {
  const owner = new V2Shells();
  owner.event({
    type: "shell.created",
    location: { directory: "/repo" },
    data: { info: info("sh_retained") },
  });
  const client = new V2Client(
    { endpoint: { url: "http://localhost:4000" }, pid: 1, version: "2.2.6" },
    1000,
    new AbortController().signal,
    () => Promise.reject(new TypeError("offline")),
  );
  await assertRejects(
    () => owner.snapshot(client, [{ directory: "/repo" }], client.signal),
    OperationFailure,
  );
  assertEquals(owner.busy("ses_owner"), true);
});
