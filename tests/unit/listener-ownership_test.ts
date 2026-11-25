// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { releasedPort } from "../support/listener-ownership.ts";

Deno.test("released port audit distinguishes closed, reassigned, owned and unidentified listeners", async () => {
  const unit = "owned-fixture.service";
  assertEquals(
    (await releasedPort(12345, unit, () => Promise.resolve([]))).state,
    "closed",
  );
  const foreign = [{ pid: 2, cgroup: "0::/user.slice/other-fixture.service" }];
  assertEquals(
    await releasedPort(12345, unit, () => Promise.resolve(foreign)),
    {
      port: 12345,
      state: "reassigned",
      listeners: foreign,
    },
  );
  for (
    const path of ["/owned-fixture.service", "/owned-fixture.service/child"]
  ) {
    await assertRejects(
      () =>
        releasedPort(12345, unit, () =>
          Promise.resolve([{
            pid: 1,
            cgroup: `0::${path}`,
          }])),
      Error,
      "Owned port survived cleanup",
    );
  }
  await assertRejects(
    () =>
      releasedPort(12345, unit, () =>
        Promise.resolve([{
          pid: 1,
          cgroup: "",
        }])),
    Error,
    "Unidentified listener",
  );
});

Deno.test("a live foreign listener is not an owned leak after numeric port reuse", async () => {
  using listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  // The former global-absence audit rejects this legitimate reuse.
  const connection = await Deno.connect({ hostname: "127.0.0.1", port });
  connection.close();
  const proof = await releasedPort(port, "retired-fixture.service");
  assertEquals(proof.state, "reassigned");
  assertEquals(proof.listeners.some((owner) => owner.pid === Deno.pid), true);
  const current = proof.listeners.find((owner) => owner.pid === Deno.pid)!;
  const unit = current.cgroup.split("/").at(-1)!;
  await assertRejects(
    () => releasedPort(port, unit),
    Error,
    "Owned port survived cleanup",
  );
});
