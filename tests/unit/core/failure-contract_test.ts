// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createFailurePresenter } from "@otk/client";
import { FailureCause, OperationFailure } from "@otk/protocol";
import { publicFailure } from "../../../core/requests/failures.ts";
import { V2Client } from "@otk/harness-opencode-v2-server";

const service = {
  endpoint: { url: "http://127.0.0.1:42" },
  version: "2.2.6",
  pid: 42,
};

Deno.test("native request rejection retains its safe reason and HTTP status", () => {
  const failure = publicFailure(
    new OperationFailure(
      "rejected",
      "native.rejected",
      new FailureCause("Native request rejected", {
        reason: "Model fixture/missing is unavailable",
        status: 400,
      }),
    ),
    () => {},
  );
  assert(
    JSON.stringify(failure).includes("Model fixture/missing is unavailable"),
    "Safe native reason was removed before presentation",
  );
  assert(
    JSON.stringify(failure).includes("400"),
    "HTTP status was removed before presentation",
  );
});

Deno.test("a new failure code presents its facts without code registration", () => {
  const failure = {
    code: "fixture.new-code",
    retry: "none" as const,
    diagnosticID: "fixture-diagnostic",
    facts: {
      action: "Renaming session",
      target: { sessionID: "tstv1-fixture", label: "Fixture session" },
      reason: "The requested title is unavailable",
      recovery: "Choose another title",
    },
  };
  const feedback = createFailurePresenter().present(failure);
  for (
    const fact of [
      "Renaming session",
      "Fixture session",
      "The requested title is unavailable",
      "Choose another title",
    ]
  ) {
    assert(feedback.text.includes(fact), `Presentation omitted ${fact}`);
  }
  assert(
    !feedback.text.includes("Try again"),
    "Fallback contradicts retry:none",
  );
});

Deno.test("finite native read timeout stays unavailable, not a terminal rejection", async () => {
  const client = new V2Client(
    service,
    10,
    new AbortController().signal,
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(init!.signal!.reason),
          { once: true },
        );
      }),
  );
  const error = await assertRejects(
    () => client.read((api) => api.session.get({ sessionID: "ses_fixture" })),
    OperationFailure,
  );
  assertEquals([error.outcome, error.code], [
    "unavailable",
    "native.unavailable",
  ]);
});

Deno.test("public summaries omit credential-bearing prose, arbitrary causes and raw native fields", async () => {
  const secret = "fixture-private-credential";
  const client = new V2Client(
    service,
    1000,
    new AbortController().signal,
    () =>
      Promise.resolve(Response.json({
        _tag: "InvalidRequestError",
        message: "The model is unavailable",
        token: secret,
        password: secret,
        authorization: secret,
        cookie: secret,
        receiptSecret: secret,
        body: { privateKey: secret },
      }, { status: 400 })),
  );
  const native = await assertRejects(
    () =>
      client.effect((api) =>
        api.session.update({ sessionID: "ses_fixture", title: "New title" })
      ),
    OperationFailure,
  );
  const value = publicFailure(native, () => {});
  assertEquals(value.facts?.reason, "The model is unavailable");
  assert(!JSON.stringify(value).includes(secret));
  for (
    const text of [
      `password=${secret}`,
      `Authorization: Bearer ${secret}`,
      `Cookie: session=${secret}`,
      `receipt-secret=${secret}`,
      `-----BEGIN PRIVATE KEY-----\n${secret}`,
    ]
  ) {
    const value = publicFailure(
      new OperationFailure(
        "rejected",
        "native.rejected",
        new FailureCause(text, { reason: text }),
      ),
      () => {},
    );
    assert(!JSON.stringify(value).includes(secret));
  }
  const unknown = publicFailure(
    new Error(secret, { cause: { password: secret } }),
    () => {},
  );
  assert(!JSON.stringify(unknown).includes(secret));
  const authenticated = new V2Client(
    {
      ...service,
      endpoint: {
        ...service.endpoint,
        auth: { type: "basic", username: "fixture", password: secret },
      },
    },
    1000,
    new AbortController().signal,
    () =>
      Promise.resolve(Response.json({
        _tag: "InvalidRequestError",
        message: `The supplied credential ${secret} is invalid`,
      }, { status: 400 })),
  );
  const echoed = await assertRejects(
    () =>
      authenticated.effect((api) =>
        api.session.update({ sessionID: "ses_fixture", title: "New title" })
      ),
    OperationFailure,
  );
  assert(!JSON.stringify(publicFailure(echoed, () => {})).includes(secret));
});
