// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type ContextMessage,
  type FailureFacts,
  OperationFailure,
  type PublicFailure,
} from "@otk/protocol";

/** Test cases accept ports: private plugin code is tested from its own package. */
export function requestFailureCases(version: string, ports: {
  submit(fetcher: typeof fetch): Promise<unknown>;
  credentialFacts(raw: unknown): FailureFacts;
  facts(
    raw: unknown,
    status?: number,
    credentials?: readonly string[],
  ): FailureFacts;
  record(
    sessionID: string,
    failure: PublicFailure,
    created?: number,
  ): ContextMessage;
  retain(message: ContextMessage): Promise<readonly ContextMessage[]>;
}) {
  Deno.test(`${version} HTTP and asynchronous capture share the configured-credential boundary`, () => {
    for (
      const secret of [
        "fixture-private-password",
        btoa("opencode:fixture-private-password"),
      ]
    ) {
      assertEquals(
        ports.credentialFacts({ message: `Rejected ${secret}` }).reason,
        "The native reason contains credential data and is not shown",
      );
    }
  });
  for (
    const sample of [
      {
        name: "ProviderModelNotFoundError",
        data: {
          providerID: "fixture",
          modelID: "scripte",
          suggestions: ["scripted", "scripted-fast"],
        },
        expected: ["fixture/scripte", "scripted", "scripted-fast"],
        status: 400,
      },
      {
        name: "ConfigInvalidError",
        data: {
          message: "Invalid provider configuration",
          path: "/project/opencode.json",
        },
        expected: ["Invalid provider configuration", "/project/opencode.json"],
        status: 400,
      },
      {
        name: "UnauthorizedError",
        data: { message: "Provider sign-in expired" },
        expected: ["Provider sign-in expired"],
        status: 401,
      },
    ]
  ) {
    Deno.test(`${version} rejected submit retains selected native facts: ${sample.name}`, async () => {
      const error = await assertRejects(
        () =>
          ports.submit(() =>
            Promise.resolve(Response.json(sample, { status: sample.status }))
          ),
        OperationFailure,
      );
      assertEquals(error.outcome, "rejected");
      assertEquals(error.facts?.status, sample.status);
      for (const text of sample.expected) {
        assert(
          error.facts?.reason?.includes(text),
          JSON.stringify(error.facts),
        );
      }
    });
  }
  Deno.test(`${version} selects only public failure facts and redacts every selected field`, async () => {
    const body = {
      name: "ConfigInvalidError",
      data: {
        message: "Invalid provider",
        path: "/home/me/opencode.json",
        issues: [{ message: "Missing model" }],
        token: "private-token",
        body: "private-response-body",
      },
    };
    const safe = ports.facts(body, 400);
    assert(safe.reason?.includes("/home/me/opencode.json"));
    assert(safe.reason?.includes("Missing model"));
    assert(!JSON.stringify(safe).includes("private-"));
    for (
      const contaminated of [
        { ...body, data: { ...body.data, message: "password=private-token" } },
        { ...body, data: { ...body.data, path: "/private-token/config.json" } },
        {
          name: "ProviderModelNotFoundError",
          data: {
            providerID: "fixture",
            modelID: "missing",
            suggestions: ["private-token"],
          },
        },
      ]
    ) {
      assertEquals(
        ports.facts(contaminated, 400, ["private-token"]).reason,
        "The native reason contains credential data and is not shown",
      );
    }
    const sessionID = `opc${version}-ses_test`,
      failure = {
        code: "native.rejected",
        retry: "new-intent" as const,
        diagnosticID: "one",
        facts: {
          ...safe,
          action: "session.prompt",
          target: { sessionID },
          outcome: "rejected" as const,
        },
      };
    const message = ports.record(sessionID, failure, 123);
    assertEquals(message.role, "context");
    assert(!("revert" in message));
    assert(!("source" in message));
    assertEquals(
      message.parts[0].kind === "external" && message.parts[0].failure,
      {
        ...failure,
        facts: {
          ...failure.facts,
          record: {
            messageID: message.id,
            label: "Not sent - see the error above",
          },
        },
      },
    );
    assertEquals(await ports.retain(message), [message]);
  });
}
