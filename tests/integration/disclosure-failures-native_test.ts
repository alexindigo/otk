// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { MessagePage } from "@otk/protocol";
import { createTranscriptInteraction, toolFailure } from "@otk/client";
import { nativeFixture } from "../support/native-fixture.ts";
import { withResources } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";

Deno.test("native nonzero tool results keep a required failure independently of lifecycle and defaults", () =>
  withResources("disclosure native failure", async () => {
    const fixture = await nativeFixture({ bash: "allow", shell: "allow" });
    fixture.fake.strict();
    const session = await fixture.oc.createSession("Disclosure failure");
    const sidecar = await fixture.sidecar();
    const client = new WsClient(sidecar.url);
    await client.connect(fixture.oc.directory, session.id);
    await client.rpc("prefs.set", { key: "toolDetails", value: false });
    fixture.fake.queue({
      tool: {
        name: "bash",
        input: { command: "exit 7", description: "Expected failure" },
      },
    }, { chunks: ["Failure recorded."] });
    await fixture.oc.prompt(session.id, "Run failing shell");
    const page = await waitFor(
      () =>
        client.rpc<MessagePage>("session.messages", { sessionID: session.id }),
      (page) =>
        page.items.some((message) =>
          message.parts.some((part) =>
            part.kind === "tool" &&
            toolFailure(part.call) === "Exited with code 7"
          )
        ),
    );
    const part = page.items.flatMap((message) => message.parts).find((part) =>
      part.kind === "tool" && part.call.tool === "bash"
    );
    assert(part?.kind === "tool");
    assertEquals(part.call.status, "completed");
    assertEquals(toolFailure(part.call), "Exited with code 7");
    const owner = createTranscriptInteraction();
    assertEquals(
      owner.disclosure("work", "one").expanded(
        "work",
        {},
        !!toolFailure(part.call),
      ),
      true,
    );
    assertEquals(owner.disclosure("tool", "one").expanded("toolOutput"), false);
  }));
