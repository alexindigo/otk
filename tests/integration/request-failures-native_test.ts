// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  createFailurePresenter,
  createTranscriptProjection,
  RequestFailure,
} from "@otk/client";
import type { ExternalPart, MessagePage } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { startNative } from "../support/native-fixture.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";
import { test } from "../support/resources.ts";
import { waitFor } from "../support/opencode.ts";
import {
  failureEndpoint,
  submitFailureScenario,
  submitRejections,
} from "../support/request-failure-fixture.ts";

const failureParts = (page: MessagePage) =>
  page.items.flatMap((message) => message.parts).filter((
    part,
  ): part is ExternalPart => part.kind === "external" && !!part.failure);
for (const kind of ["model", "provider"] as const) {
  test(`request failures: stock native ${kind} failure remains attached to its accepted turn`, async () => {
    const fake = new FakeLlm();
    if (kind === "provider") {
      fake.failRemaining("Provider sign-in expired", 401);
    }
    const native = await startNative(fake),
      session = await native.createSession(`Accepted ${kind} failure`);
    const app = await SidecarTest.start(native), ws = new WsClient(app.url);
    try {
      await ws.connect(native.directory, session.id);
      await ws.rpc("session.prompt", {
        sessionID: session.id,
        mode: "normal",
        model: {
          provider: "fake",
          model: kind === "model" ? "scripte" : "scripted",
        },
        parts: [{ kind: "text", text: `Accepted ${kind} prompt` }],
      });
      let page = await waitFor(
        () =>
          ws.rpc<MessagePage>("session.messages", { sessionID: session.id }),
        (page) => failureParts(page).length > 0,
      );
      if (native.kind === "opencode-v1" && kind === "model") {
        // Wait for stock promptAsync's second report, not just getModel's first.
        await waitFor(
          () => ws.entry(session.id)?.attention.errorState,
          (state) =>
            state?.observations.some((observation) =>
              observation.message.includes("ProviderModelNotFoundError")
            ) === true,
        );
        page = await ws.rpc<MessagePage>("session.messages", {
          sessionID: session.id,
        });
      }
      assertEquals(
        failureParts(page).length,
        1,
        "One failed native turn has one retained record",
      );
      const prompt = page.items.find((message) => message.role === "user");
      assert(prompt, "Native accepted and stored the prompt");
      const failure = page.items.find((message) =>
        message.parts.some((part) => part.kind === "external" && part.failure)
      );
      assert(failure?.role === "context");
      assert(
        page.items.indexOf(failure) > page.items.indexOf(prompt),
        "The retained failure follows its causal prompt",
      );
      assertEquals(
        failure.replyTo,
        prompt.id,
        "The plugin record identifies the failed native turn",
      );
      const part = failureParts(page)[0];
      const shown = createFailurePresenter().describe(part.failure!, "record");
      assert(
        shown.text.includes(
          kind === "model" ? "scripte" : "Provider sign-in expired",
        ),
        shown.text,
      );
      if (kind === "provider") assertEquals(part.failure?.facts?.status, 401);
      assertEquals(part.failure?.facts?.target?.sessionID, session.id);
      assertEquals(part.failure?.facts?.record?.messageID, failure.id);
      if (native.kind === "opencode-v1" && kind === "model") {
        assert(
          shown.text.includes("scripted") &&
            shown.text.includes("gpt-scripted"),
        );
      }
      const projection = createTranscriptProjection();
      projection.replace(page.items);
      assert(
        projection.state.repliesByID[`reply:${prompt.id}`].messageIDs.includes(
          failure.id,
        ),
      );
      const again = await ws.rpc<MessagePage>("session.messages", {
        sessionID: session.id,
      });
      assertEquals(
        failureParts(again).map((p) => p.failure?.diagnosticID),
        failureParts(page).map((p) => p.failure?.diagnosticID),
      );
    } finally {
      await ws.close();
      await app.stop();
      await native.stop();
    }
  });
}

test("request failures: source-backed native submit rejections persist without a native message", async () => {
  const fake = new FakeLlm(),
    native = await startNative(fake),
    scenario = submitFailureScenario(native);
  const endpoint = await failureEndpoint(native, scenario.url),
    session = await native.createSession("Unsent failure");
  let app = await SidecarTest.start(endpoint), ws = new WsClient(app.url);
  try {
    await ws.connect(native.directory, session.id);
    for (const kind of ["config", "model", "auth"] as const) {
      scenario.control(kind);
      const error = await assertRejects(
        () =>
          ws.rpc("session.prompt", {
            sessionID: session.id,
            mode: "normal",
            parts: [{ kind: "text", text: "Never sent secret draft" }],
          }),
        RequestFailure,
      );
      assertEquals(error.failure.facts?.status, submitRejections[kind].status);
      const page = await ws.rpc<MessagePage>("session.messages", {
        sessionID: session.id,
      });
      assertEquals(
        page.items.filter((message) => message.role === "user").length,
        0,
      );
      const records = failureParts(page);
      assert(
        records.some((part) =>
          part.failure?.diagnosticID === error.failure.diagnosticID
        ),
      );
      assert(!JSON.stringify(records).includes("Never sent secret draft"));
    }
    const original = failureParts(
      await ws.rpc<MessagePage>("session.messages", { sessionID: session.id }),
    );
    assertEquals(original.length, 3);
    const shown = original.map((part) =>
      createFailurePresenter().describe(part.failure!, "record").text
    ).join("\n");
    for (
      const text of [
        "opencode.config.ts",
        "Required",
        "Invalid",
        "x/y2",
        "x/y3",
        "Unauthorized",
        "HTTP 400",
        "HTTP 404",
        "HTTP 401",
      ]
    ) assert(shown.includes(text), shown);
    await ws.close();
    const port = app.port;
    await app.stop();
    app = await SidecarTest.start(endpoint, {
      server: { port },
      state: { path: `${native.root}/otk-${port}` },
    });
    ws = new WsClient(app.url);
    await ws.connect(native.directory, session.id);
    assertEquals(
      failureParts(
        await ws.rpc<MessagePage>("session.messages", {
          sessionID: session.id,
        }),
      ),
      original,
      "Plugin records survive OTK restart",
    );
    assertEquals(fake.requests.length, 0);
  } finally {
    await ws.close();
    await app.stop();
    await native.stop();
  }
});

test("request failures: native HTTP 503 facts stay visible without fabricating a definite outcome or redispatch", async () => {
  const fake = new FakeLlm(),
    native = await startNative(fake),
    scenario = submitFailureScenario(native);
  scenario.control("unavailable");
  const endpoint = await failureEndpoint(native, scenario.url),
    session = await native.createSession("Unknown submit outcome");
  const app = await SidecarTest.start(endpoint), ws = new WsClient(app.url);
  try {
    await ws.connect(native.directory, session.id);
    const welcome = ws.frames.find((frame) => frame.t === "welcome");
    assert(welcome?.t === "welcome");
    const ref = {
      id: crypto.randomUUID(),
      key: crypto.randomUUID(),
      clientID: crypto.randomUUID(),
      window: welcome.requests.window.id,
    };
    ws.send({
      t: "request",
      ref,
      method: "session.prompt",
      params: {
        sessionID: session.id,
        mode: "normal",
        parts: [{ kind: "text", text: "Keep while the outcome is checked" }],
      },
    });
    await ws.wait((frame) =>
      frame.t === "request.progress" && frame.ref.key === ref.key &&
      frame.progress.code === "checking-outcome"
    );
    const page = await ws.rpc<MessagePage>("session.messages", {
      sessionID: session.id,
    });
    const failure = failureParts(page)[0]?.failure;
    assert(failure);
    assertEquals(failure.facts?.status, 503);
    assertEquals(failure.facts?.outcome, "unknown");
    const shown = createFailurePresenter().describe(failure, "record");
    assertEquals(shown.kind, "pending");
    assert(shown.text.includes("Location plugins did not finish activating"));
    assertEquals(shown.failure?.recovery, undefined);
    assertEquals(
      page.items.filter((message) => message.role === "user").length,
      0,
    );
    assertEquals(scenario.observe().rejected, 1);
    assertEquals(fake.requests.length, 0);
  } finally {
    await ws.close();
    await app.stop();
    await native.stop();
  }
});
