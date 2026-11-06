// SPDX-License-Identifier: LGPL-3.0-only
/** Independent application composition for source/compiled worker qualification. */
import { DigestBridge } from "../../core/digest/bridge.ts";
const [statePath, url, db, target] = Deno.args;
const bridge = new DigestBridge({
  statePath,
  provider: "opencode-v1",
  native: {
    harness: {
      url,
      db,
      username: "",
      password: "",
      heartbeattimeout: 25,
      reconnectmax: 30,
      requestms: 60000,
    },
    index: { days: 30 },
    attachments: { concurrency: 1, maxrefs: 10, maxbytes: 1024 },
  },
  policy: {
    batch: 2,
    slicems: 8,
    cpu: 1,
    memoryreserve: 1,
    maxpending: 2,
    publishrows: 2,
    retryms: 10,
    busyms: 100,
  },
  publish(value) {
    if (value.sessionID === target) console.log(JSON.stringify(value));
  },
  diagnostic: (error) => console.error(error.message),
});
try {
  bridge.scope("consumer", { sessions: [target] });
  await bridge.start();
  await bridge.catalog(1, new AbortController().signal);
  for await (const chunk of Deno.stdin.readable) {
    if (new TextDecoder().decode(chunk).includes("stop")) break;
    bridge.observe(1, [{
      sessionID: target,
      revision: Date.now(),
      reason: "messages",
    }]);
  }
} finally {
  await bridge.stop();
}
