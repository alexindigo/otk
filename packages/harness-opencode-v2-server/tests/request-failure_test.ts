// SPDX-License-Identifier: LGPL-3.0-only
import { V2Client } from "../client.ts";
import {
  requestFailureFacts,
  requestFailureRecord,
} from "../request-failure.ts";
import { V2RequestRetention } from "../request-retention.ts";
import type { ContextMessage } from "@otk/protocol";
import { requestFailureCases } from "../../../tests/support/request-failure-cases.ts";

const service = {
  endpoint: { url: "http://127.0.0.1:42" },
  version: "2.2.6",
  pid: 42,
};
requestFailureCases("v2", {
  submit: (fetcher) =>
    new V2Client(service, 1000, new AbortController().signal, fetcher).effect(
      (api) => api.session.prompt({ sessionID: "ses_one", text: "draft" }),
    ),
  credentialFacts: (raw) =>
    new V2Client(
      {
        ...service,
        endpoint: {
          ...service.endpoint,
          auth: {
            type: "basic",
            username: "opencode",
            password: "fixture-private-password",
          },
        },
      },
      1000,
      new AbortController().signal,
    ).failureFacts(raw),
  facts: requestFailureFacts,
  record: requestFailureRecord,
  retain: async (message) => {
    const retention = new V2RequestRetention();
    await retention.put({
      id: message.id.replace(/^request:/, ""),
      sessionID: message.sessionID,
      outcome: message,
      position: { after: 0, rank: 1, basis: "stream" },
    });
    return await retention.page(
      message.sessionID,
      undefined,
      10,
    ) as ContextMessage[];
  },
});
