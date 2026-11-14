// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createFailurePresenter, RequestFailure } from "@otk/client";
import { FakeLlm } from "../support/fake-llm.ts";
import { startNative } from "../support/native-fixture.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";
import { test } from "../support/resources.ts";

test("native missing-session rejection preserves action, target and reason at the browser client boundary", async () => {
  const native = await startNative(new FakeLlm());
  const app = await SidecarTest.start(native), ws = new WsClient(app.url);
  try {
    await ws.connect();
    const sessionID = native.kind === "opencode-v2-server"
      ? "opcv2-ses_missing"
      : "opcv1-ses_missing";
    const cause = await assertRejects(
      () =>
        ws.rpc("session.rename", {
          sessionID,
          title: "Private submitted title",
        }),
      RequestFailure,
    );
    assertEquals(cause.failure.facts?.action, "session.rename");
    assertEquals(cause.failure.facts?.target?.sessionID, sessionID);
    assert(
      cause.failure.facts?.reason,
      "The native semantic reason must survive the server boundary",
    );
    const shown = createFailurePresenter().present(cause.failure);
    assert(shown.text.includes("Renaming session"));
    assert(shown.text.includes(cause.failure.facts.reason));
    assertEquals(shown.failure?.target.href, `#/local/${sessionID}`);
    assert(
      !JSON.stringify(cause.failure).includes("Private submitted title"),
      "Captured request inputs are not failure facts",
    );
    const first = ws.frames.findLast((frame) =>
      frame.t === "request.result" && !frame.outcome.ok
    );
    assert(first?.t === "request.result" && !first.outcome.ok);
    const replay = { ...first.ref, id: crypto.randomUUID() };
    ws.send({ t: "request.resume", items: [{ ref: replay, after: 0 }] });
    const restored = await ws.wait((frame) =>
      frame.t === "request.result" && frame.ref.id === replay.id
    );
    assert(restored.t === "request.result" && !restored.outcome.ok);
    assertEquals(
      restored.outcome.error,
      first.outcome.error,
      "Receipt replay preserves the original public facts and diagnostic identity",
    );
  } finally {
    await ws.close();
    await app.stop();
    await native.stop();
  }
});
