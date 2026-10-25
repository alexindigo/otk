// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { Client, HttpFailure } from "../client.ts";

Deno.test("native HTTP errors preserve both reason envelopes and use a plain fallback instead of JSON", async () => {
  for (
    const [body, status, expected] of [
      [
        {
          name: "NotFoundError",
          data: {
            message: "Message not found: msg_missing",
            ref: "legacy-ref",
          },
        },
        404,
        {
          message: "That message is no longer in the session.",
          kind: "NotFoundError",
          ref: "legacy-ref",
        },
      ],
      [
        {
          _tag: "SessionBusyError",
          sessionID: "ses_busy",
          message: "Session is busy: ses_busy",
        },
        409,
        {
          message: "The session is working. Try again when it finishes.",
          kind: "SessionBusyError",
        },
      ],
      [
        {
          _tag: "UnknownError",
          message: "Native operation failed",
          ref: "native-ref",
        },
        500,
        {
          message: "Native operation failed",
          kind: "UnknownError",
          ref: "native-ref",
        },
      ],
      [{ name: "UnknownError", data: { detail: "internal object" } }, 500, {
        message: "Request failed (HTTP 500).",
        kind: "UnknownError",
      }],
      [{ message: "" }, 500, { message: "Request failed (HTTP 500)." }],
      [{}, 500, { message: "Request failed (HTTP 500)." }],
    ] as const
  ) {
    const client = new Client({
      url: "http://fixture",
      username: "",
      password: "",
      db: "",
      heartbeattimeout: 25,
      reconnectmax: 30,
    }, () => Promise.resolve(Response.json(body, { status })));
    const failure = await assertRejects(
      () => client.json("/session/test/revert"),
      HttpFailure,
    );
    assertEquals(failure.status, status);
    assertEquals(failure.message, expected.message);
    assertEquals(failure.detail, expected);
  }
});

const mapped = [
  [
    "SessionBusyError",
    409,
    "The session is working. Try again when it finishes.",
  ],
  ["MessageNotFoundError", 404, "That message is no longer in the session."],
  ["SessionNotFoundError", 404, "That session is no longer available."],
  [
    "PermissionNotFoundError",
    404,
    "That permission request is no longer pending.",
  ],
  ["QuestionNotFoundError", 404, "That question is no longer pending."],
  ["PtyNotFoundError", 404, "That terminal is no longer available."],
  ["ProjectNotFoundError", 404, "That project is no longer available."],
  ["ProviderNotFoundError", 404, "That provider is no longer available."],
  ["ModelNotFoundError", 404, "That model is no longer available."],
  ["McpServerNotFoundError", 404, "That MCP server is no longer available."],
] as const;

async function failure(body: unknown, status = 500) {
  const client = new Client({
    url: "http://fixture",
    username: "",
    password: "",
    db: "",
    heartbeattimeout: 25,
    reconnectmax: 30,
  }, () => Promise.resolve(Response.json(body, { status })));
  return await assertRejects(
    () => client.json("/session/test/revert"),
    HttpFailure,
  );
}

for (const [kind, status, message] of mapped) {
  for (const legacy of [false, true]) {
    Deno.test(`${kind} maps ${legacy ? "legacy" : "native"} diagnostics to user language without identities`, async () => {
      for (
        const reason of ["Internal ses_private msg_private", "", undefined]
      ) {
        const detail = {
          sessionID: "ses_private",
          messageID: "msg_private",
          requestID: "request-private",
          projectID: "opaque-project-hash",
          providerID: "private-provider",
          modelID: "private-model",
          ptyID: "pty_private",
          name: "private-mcp",
          message: reason,
          ref: "diagnostic-reference",
        };
        const error = await failure(
          legacy ? { name: kind, data: detail } : { ...detail, _tag: kind },
          status,
        );
        assertEquals(error.message, message);
        assertEquals(error.detail, {
          message,
          kind,
          ref: "diagnostic-reference",
        });
      }
    });
  }
}

Deno.test("legacy not-found diagnostics identify the unavailable item without copying its ID", async () => {
  for (
    const [reason, message] of [
      [
        "Message not found: msg_private",
        "That message is no longer in the session.",
      ],
      [
        "Session not found: ses_private",
        "That session is no longer available.",
      ],
      [
        "Part not found: prt_private",
        "That message part is no longer in the session.",
      ],
      [
        "Resource not found: /state/message/ses_private/msg_private.json",
        "That message is no longer in the session.",
      ],
      [
        "Resource not found: /state/session/project/ses_private.json",
        "That session is no longer available.",
      ],
      [
        "Resource not found: opaque-private-key",
        "The requested item is no longer available.",
      ],
    ]
  ) {
    const error = await failure({
      name: "NotFoundError",
      data: { message: reason },
    }, 404);
    assertEquals(error.message, message);
    assertEquals(error.detail.message, message);
  }
});

Deno.test("unmapped native reasons retain readable detail but never raw native or envelope IDs", async () => {
  for (
    const kind of [
      "InvalidRequestError",
      "UnauthorizedError",
      "ForbiddenError",
      "ConflictError",
      "UpstreamError",
      "ServiceUnavailableError",
      "TimeoutError",
      "UnknownError",
      "InvalidCursorError",
      "PtyForbiddenError",
      "FutureNativeError",
    ]
  ) {
    for (
      const prefix of [
        "job",
        "evt",
        "ses",
        "msg",
        "per",
        "que",
        "prt",
        "pty",
        "tool",
        "wrk",
      ]
    ) {
      const error = await failure({
        _tag: kind,
        message: `Failure for ${prefix}_private`,
      });
      assertEquals(error.message, "Request failed (HTTP 500).");
      assertEquals(error.detail.message, error.message);
    }
    for (const legacy of [false, true]) {
      const detail = {
        message: "Cannot load opaque-private-key",
        sessionID: "opaque-private-key",
      };
      const error = await failure(
        legacy ? { name: kind, data: detail } : { _tag: kind, ...detail },
      );
      assertEquals(error.message, "Request failed (HTTP 500).");
    }
    const readable = await failure({
      _tag: kind,
      message: "The upstream service is unavailable.",
    });
    assertEquals(readable.message, "The upstream service is unavailable.");
  }
});
