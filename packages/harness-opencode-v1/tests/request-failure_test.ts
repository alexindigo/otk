// SPDX-License-Identifier: LGPL-3.0-only
import { Client } from "../client.ts";
import {
  requestFailureFacts,
  requestFailureRecord,
} from "../request-failure.ts";
import { V1RecordRetention } from "../record-retention.ts";
import { requestFailureCases } from "../../../tests/support/request-failure-cases.ts";

const config = {
  url: "http://127.0.0.1:42",
  username: "opencode",
  password: "",
  db: "",
  requestms: 1000,
  heartbeattimeout: 25,
  reconnectmax: 30,
};
requestFailureCases("v1", {
  submit: (fetcher) =>
    new Client(config, fetcher).request("/session/ses_one/prompt_async", {
      method: "POST",
    }),
  credentialFacts: (raw) =>
    new Client({ ...config, password: "fixture-private-password" })
      .failureFacts(raw),
  facts: requestFailureFacts,
  record: requestFailureRecord,
  retain: (message) => {
    const retention = new V1RecordRetention();
    retention.put({
      id: message.id,
      sessionID: message.sessionID,
      created: message.time.created,
      message,
    });
    return Promise.resolve(retention.page(message.sessionID, undefined, 10));
  },
});
