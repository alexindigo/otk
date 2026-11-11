// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { basename, join } from "@std/path";
import { nativeKind } from "../../support/native.ts";
import { FakeLlm } from "../../support/fake-llm.ts";
import { SCALE, SCALE_VARIANTS } from "../../support/session-scale.ts";
import { V2SessionScale } from "../../support/v2-session-scale.ts";
import { fileHashes } from "../../support/snapshots.ts";
import { withResources } from "../../support/resources.ts";
import { SidecarTest } from "../../support/sidecar.ts";
import { WsClient } from "../../support/ws-client.ts";
import { waitFor } from "../../support/opencode.ts";

for (const variant of SCALE_VARIANTS) {
  Deno.test({
    name:
      `OC2Scale1 ${variant} recipe admits isolated private native populations and fresh OTK totals without changing its source`,
    ignore: nativeKind !== "opencode-v2-server",
    fn: () =>
      withResources(`V2 portable ${variant}`, async () => {
        const fake = new FakeLlm();
        const [template, joined] = await Promise.all([
          V2SessionScale.generate(variant, fake),
          V2SessionScale.generate(variant, fake),
        ]);
        assertEquals(template, joined);
        assertEquals(
          basename(template),
          (await V2SessionScale.identity(variant)).key,
        );
        const inode = (await Deno.stat(template + ".lock")).ino;
        assertEquals((await Deno.stat(joined + ".lock")).ino, inode);
        const source = await fileHashes(template),
          recipe = await V2SessionScale.validate(template);
        assertEquals(recipe.counts, SCALE);
        assert(
          !Object.keys(source).some((path) => /\.(db|sqlite)$/.test(path)),
          "V2 portable recipes must not reuse a V1/native/OTK database",
        );
        const [a, b] = await Promise.all([
          V2SessionScale.materialize(template, fake),
          V2SessionScale.materialize(template, fake),
        ]);
        assertNotEquals(a.directory, b.directory);
        for (const fixture of [a, b]) {
          assertEquals(fixture.population().sessions, SCALE.sessions);
          const config = JSON.parse(
            await Deno.readTextFile(
              join(fixture.root, "config/opencode/opencode.json"),
            ),
          );
          assertEquals(
            config.providers.fake.settings.baseURL,
            `http://127.0.0.1:${fake.port}/v1`,
          );
          const rows = await fixture.native.api.session.list({
            directory: fixture.directory,
            limit: 200,
            order: "desc",
          });
          assert(
            rows.data.length > 0 &&
              rows.data.every((row) =>
                row.location.directory === fixture.directory
              ),
          );
          const page = await fixture.native.api.message.list({
            sessionID: fixture.sessions[0].nativeID,
            limit: 10,
            order: "desc",
          });
          assertEquals(page.data.length, 10);
          assert(page.data.every((row) => row.id.startsWith("msg_scale")));
          for (const target of fixture.sessions.slice(0, 2)) {
            const info = await fixture.native.api.session.get({
              sessionID: target.nativeID,
            });
            // Native mandatory totals stay zero when no constituent reports;
            // target.expected describes OTK authority, not native defaults.
            assertEquals(info.cost, target.expected.cost ?? 0);
            assertEquals([
              info.tokens.input,
              info.tokens.output,
              info.tokens.reasoning,
              info.tokens.cache.read,
              info.tokens.cache.write,
            ], target.expected.tokens.map((value) => value ?? 0));
          }
          // Native session aggregates are mandatory even when a provider did
          // not report call usage. Unknown reply categories must stay unknown.
          const unknown = fixture.sessions[1];
          const unknownPage = await fixture.native.api.message.list({
            sessionID: unknown.nativeID,
            limit: 10,
            order: "desc",
          });
          assert(unknownPage.data.some((row) => row.type === "assistant"));
          for (const row of unknownPage.data) {
            if (row.type !== "assistant") continue;
            assertEquals(row.cost, undefined);
            assertEquals(row.tokens, undefined);
          }
          assert(
            Object.values(unknown.expected.turns).every((turn) =>
              turn.cost === null && turn.tokens.every((value) => value === null)
            ),
          );
        }
        await a.native.api.session.update({
          sessionID: a.sessions[0].nativeID,
          title: "Private A mutation",
        });
        assertEquals(
          (await a.native.api.session.get({
            sessionID: a.sessions[0].nativeID,
          })).title,
          "Private A mutation",
        );
        assertEquals(
          (await b.native.api.session.get({
            sessionID: b.sessions[0].nativeID,
          })).title,
          b.sessions[0].title,
        );
        const app = await SidecarTest.start(a.native, {
          digest: { cpu: 1, memoryreserve: 1, idlems: 1 },
        });
        const client = new WsClient(app.url), selected = a.sessions[0];
        client.lease({
          directory: a.directory,
          selected: selected.id,
          crumbs: [],
          rows: [],
        });
        await client.connect();
        await client.rpc("session.messages", { sessionID: selected.id });
        await waitFor(
          () => client.entry(selected.id)?.digest,
          (digest) => digest?.state === "ready",
          120000,
        );
        assertEquals(
          client.entry(selected.id)?.digest.messageCount,
          selected.expected.messages,
        );
        assertEquals(
          client.entry(selected.id)?.digest.total?.calls,
          selected.expected.calls,
        );
        assertEquals(
          client.entry(selected.id)?.digest.total?.cost,
          selected.expected.cost,
        );
        assertEquals(
          client.entry(selected.id)?.digest.total?.tokens.input,
          selected.expected.tokens[0],
        );
        // Each recipe seeds omitted usage at 1 and explicit zeros at 2.
        for (const target of a.sessions.slice(1, 3)) {
          client.lease({
            directory: a.directory,
            selected: target.id,
            crumbs: [],
            rows: [],
          });
          await client.rpc("session.messages", { sessionID: target.id });
          await waitFor(
            () => client.entry(target.id)?.digest,
            (digest) => digest?.state === "ready",
            120000,
          );
          assertEquals(
            client.entry(target.id)?.digest.total?.cost,
            target.expected.cost,
          );
          assertEquals(
            client.entry(target.id)?.digest.total?.tokens.input,
            target.expected.tokens[0],
          );
          const [turnID, expected] = Object.entries(target.expected.turns)[0];
          const usage = await client.rpc<
            import("@otk/protocol").TurnUsageDetail
          >("usage.get", { sessionID: target.id, turnID });
          assertEquals(usage.aggregation, "reported");
          assertEquals(usage.summary.cost, expected.cost);
          assertEquals(usage.summary.tokens.input, expected.tokens[0]);
        }
        await client.close();
        assertEquals(await fileHashes(template), source);
        await V2SessionScale.validate(template);
      }),
  });
}
