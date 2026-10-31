// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { History, opencodeV1ReadCodecs } from "@otk/harness-opencode-v1";
import { OperationFailure } from "@otk/protocol";
import { DigestBridge } from "../../core/digest/bridge.ts";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest } from "../support/opencode.ts";
import { tempDir, test } from "../support/resources.ts";

test("real provider history batches cross the existing worker without durable content and cannot recover a deleted provider", async () => {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const session = await oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Worker recall" },
  });
  const secret = "m4-c3-provider-only-prompt";
  const pixels =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  await oc.request(`/session/${session.id}/message`, {
    method: "POST",
    body: {
      noReply: true,
      parts: [
        { type: "text", text: secret },
        ...["a.png", "b.png"].map((filename) => ({
          type: "file",
          filename,
          mime: "image/png",
          url: `data:image/png;base64,${pixels}`,
        })),
      ],
    },
  });
  const settings = cfg();
  settings.harness.url = oc.url;
  settings.harness.db = oc.db;
  const statePath = await tempDir("history-worker-");
  const bridge = new DigestBridge({
    statePath,
    provider: "opencode-v1",
    native: settings,
    policy: { ...settings.digest, cpu: 1, publishrows: 1 },
    reads: opencodeV1ReadCodecs,
    publish() {},
  });
  const history = new History(bridge, settings.attachments);
  try {
    const entries = await history.listHistory();
    assertEquals(entries[0].input, secret);
    assertEquals(JSON.stringify(entries).includes(pixels), false);
    const refs = entries[0].parts.filter((p) =>
      p.kind === "file" && p.source === "history"
    );
    assertEquals(refs.length, 2);
    const uploads = await history.attachments(refs.toReversed());
    assertEquals(uploads.map((v) => [v.part.name, v.part.dataBase64]), [[
      "b.png",
      pixels,
    ], ["a.png", pixels]]);
    const messageID = refs[0].messageID;
    assertEquals((await history.entry(session.id, messageID))?.input, secret);
    const missing = await assertRejects(() =>
      history.attachments([...refs, {
        messageID: "missing",
        partID: "missing",
      }]), OperationFailure);
    assertEquals(missing.outcome, "rejected");
    for (
      const file of [
        join(statePath, "digest.db"),
        join(statePath, "digest.db-wal"),
      ]
    ) {
      try {
        const bytes = new TextDecoder().decode(await Deno.readFile(file));
        assert(!bytes.includes(secret));
        assert(!bytes.includes(pixels));
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    // Preserve the owned fixture while removing its path from provider authority.
    await Deno.rename(oc.db, oc.db + ".retired");
    const unavailable = await assertRejects(
      () => history.listHistory(),
      OperationFailure,
    );
    assertEquals(unavailable.outcome, "unavailable");
    assertEquals(
      (await assertRejects(() => history.attachments(refs), OperationFailure))
        .outcome,
      "unavailable",
    );
  } finally {
    history.close();
    await bridge.stop();
    await oc.stop();
    await fake.stop();
  }
});
