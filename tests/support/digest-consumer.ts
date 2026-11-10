// SPDX-License-Identifier: LGPL-3.0-only
/** Independent application composition for source/compiled worker qualification. */
import { DigestBridge } from "../../core/digest/bridge.ts";
import { opencodeV1ReadCodecs } from "@otk/harness-opencode-v1";
import { opencodeV2ReadCodecs } from "@otk/harness-opencode-v2-server";
const [statePath, url, db, target, provider = "opencode-v1", serviceFile] =
  Deno.args;
const bridge = new DigestBridge({
  statePath,
  provider,
  reads: provider === "opencode-v2-server"
    ? opencodeV2ReadCodecs
    : opencodeV1ReadCodecs,
  native: provider === "opencode-v2-server"
    ? {
      serviceFile,
      db,
      requestms: 60000,
      attachments: { concurrency: 1, maxrefs: 10, maxbytes: 1024 },
    }
    : {
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
    idlems: 1,
    parallel: 3,
    background: false,
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
  await bridge.hydrate([target], new AbortController().signal);
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
