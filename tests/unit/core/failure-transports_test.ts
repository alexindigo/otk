// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { DirectoryCatalogs, type ProviderReadPort } from "@otk/harness";
import { FailureCause, OperationFailure, preserveFailure } from "@otk/protocol";

Deno.test("public failure transport retains typed facts and original diagnostic identity", () => {
  const cause = new OperationFailure(
    "rejected",
    "native.rejected",
    new FailureCause("Native rejection", {
      reason: "The model is unavailable",
      status: 404,
    }),
  );
  assertEquals(
    preserveFailure(cause, {
      code: cause.code,
      retry: "new-intent",
      diagnosticID: "replacement",
    }),
    {
      code: "native.rejected",
      retry: "new-intent",
      diagnosticID: cause.diagnosticID,
      facts: { reason: "The model is unavailable", status: 404 },
    },
  );
  assertEquals(
    preserveFailure(new Error("private exception"), {
      code: "local",
      retry: "none",
      diagnosticID: "local",
    }).facts,
    {},
  );
});

Deno.test("directory catalog publishes the native failure facts rather than rebuilding a generic error", async () => {
  const cause = new OperationFailure(
    "unavailable",
    "native.unavailable",
    new FailureCause("Native catalog unavailable", {
      reason: "The provider catalog cannot be read",
      status: 503,
    }),
  );
  const reads: ProviderReadPort = {
    read: () => Promise.reject(cause),
    release() {},
  };
  const owner = new DirectoryCatalogs(reads, { pending: 100 });
  const lease = owner.acquire("/fixture");
  try {
    await assertRejects(() => lease.get("models"));
    const failure = lease.snapshot().values.models?.failure;
    assertEquals(failure?.facts, cause.facts);
    assertEquals(failure?.diagnosticID, cause.diagnosticID);
  } finally {
    lease.release();
    await owner.stop();
  }
});
