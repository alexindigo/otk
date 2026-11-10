// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  discoverV2,
  HistoryReader,
  OpencodeV2ServerAdapter,
  V2Client,
} from "@otk/harness-opencode-v2-server";
import {
  arrayReadCodec,
  historyAttachmentCodec,
  ProviderHistory,
  type ProviderReadKinds,
  type ProviderReadOptions,
  type ProviderReadPort,
} from "@otk/harness";
import { OperationFailure } from "@otk/protocol";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { McpFixture } from "../support/mcp.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { nativeKind } from "../support/native.ts";
import { resources, withResources } from "../support/resources.ts";
import { waitFor } from "../support/opencode.ts";

Deno.test({
  name:
    "OC2C1 native directory catalogs preserve prices, variants, skills, commands, MCP and complete files",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 catalogs", async () => {
      const fake = new FakeLlm(),
        mcp = new McpFixture({
          templates: [{
            name: "By key",
            uriTemplate: "otk-fixture://items/{key}",
            mimeType: "text/plain",
          }],
        });
      const config: Record<string, unknown> = {
        providers: {
          fake: {
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: {
              baseURL: `http://127.0.0.1:${fake.port}/v1`,
              apiKey: "catalog-secret",
            },
            models: {
              scripted: {
                name: "Catalog model",
                variants: [{
                  id: "high",
                  settings: { reasoningEffort: "high" },
                }],
                cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }, {
                  tier: { type: "context", size: 200000 },
                  input: 2,
                  output: 3,
                  cache: { read: 1, write: 2 },
                }],
              },
            },
          },
        },
        commands: {
          hello: {
            template: "Do not expose command bodies",
            description: "Native hello",
          },
        },
        mcp: {
          servers: { fixture: { type: "remote", url: mcp.url, oauth: false } },
        },
      };
      const native = await OpencodeV2Test.start(fake, {
        config,
        prepare: async (test) => {
          const skill = `${test.directory}/skills/catalog-skill`;
          await Deno.mkdir(skill, { recursive: true });
          await Deno.writeTextFile(
            `${skill}/SKILL.md`,
            "---\nname: catalog-skill\ndescription: Catalog skill\n---\nDo not expose skill bodies\n",
          );
          config.skills = [`${test.directory}/skills`];
          await Deno.mkdir(`${test.directory}/docs`);
          for (let index = 0; index < 125; index++) {
            await Deno.writeTextFile(
              `${test.directory}/docs/file-${
                String(index).padStart(3, "0")
              }.md`,
              "fixture",
            );
          }
          await Deno.symlink(test.directory, `${test.directory}/cycle`);
        },
      });
      const target = await native.createSession(), settings = cfg();
      const adapter = new OpencodeV2ServerAdapter({
        serviceFile: native.serviceFile,
        harness: settings.harness,
        messages: settings.messages,
        digest: settings.digest,
        catalogs: settings.catalogs,
      });
      resources().defer("catalog adapter", () => adapter.core.stop());
      await adapter.core.start({
        connection: () => {},
        indexReset: () => {},
        indexUpsert: () => {},
        indexRemove: () => {},
        content: () => {},
        bootstrapComplete: () => {},
        invalidate: () => {},
      });
      assertFalse(Object.hasOwn(adapter.capabilities, "resources"));
      const services = adapter.catalogs!;
      const models = await adapter.capabilities.models!.listModels(target.id);
      const model = models.providers.find((provider) => provider.id === "fake")!
        .models.find((model) => model.id === "scripted")!;
      assertEquals(model.variants, ["high"]);
      assertEquals(model.free, false);
      assertEquals(model.cost, undefined);
      assertEquals(model.costs?.length, 2);
      assertEquals(model.costs?.[1].tier, { type: "context", size: 200000 });
      assertEquals(models.default, { provider: "fake", model: "scripted" });
      assertEquals(models.defaultState, "configured");
      assert(
        model.provenance!.some((source) => source.source === "configuration"),
      );
      assertFalse(JSON.stringify(models).includes("catalog-secret"));
      const commands = await services.listCommands(target.id);
      assert(
        commands.some((command) =>
          command.name === "hello" && command.source === "unknown"
        ),
      );
      assert(
        commands.some((command) =>
          command.name === "catalog-skill" && command.source === "skill" &&
          !!command.skillID
        ),
      );
      const skills = await services.catalogs.get(native.directory, "skills");
      assertFalse(
        JSON.stringify(skills).includes("Do not expose skill bodies"),
      );
      const catalogs = await services.catalogs.get(
        native.directory,
        "resources",
      );
      assert(
        catalogs.some((resource) =>
          resource.name === "specification" && resource.server === "fixture" &&
          resource.uri === "otk-fixture://specification"
        ),
      );
      const templates = await services.catalogs.get(
        native.directory,
        "resourceTemplates",
      );
      assertEquals(
        templates.map((template) => [template.name, template.uriTemplate]),
        [["By key", "otk-fixture://items/{key}"]],
      );
      const files = await adapter.capabilities.files!.findFiles(
        target.id,
        "docs/file-",
      );
      assertEquals(files.length, 125);
      assertFalse(
        (await services.catalogs.get(native.directory, "files")).some((file) =>
          file.path.startsWith(".git") || file.path.startsWith("cycle/")
        ),
      );
      const lease = services.catalogs.acquire(native.directory);
      await lease.get("files");
      await Deno.writeTextFile(
        `${native.directory}/docs/added.md`,
        "new fixture",
      );
      await waitFor(
        async () =>
          (await lease.get("files")).some((file) =>
            file.path === "docs/added.md"
          ),
        Boolean,
      );
      lease.release();
      assertFalse(
        mcp.requests.some((request) => request.method === "resources/read"),
      );
    }),
});

Deno.test({
  name:
    "OC2C2 native recall hydrates admitted bytes on intent through the existing bounded read codecs",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 history", async () => {
      const fake = new FakeLlm();
      fake.queue({ chunks: ["Recall fixture complete"] });
      const native = await OpencodeV2Test.start(fake),
        target = await native.createSession();
      await native.api.session.switchModel({
        sessionID: target.nativeID,
        model: { providerID: "fake", id: "scripted" },
      });
      await native.api.session.prompt({
        sessionID: target.nativeID,
        text: "Recall this admitted upload",
        files: [{
          uri: "data:text/plain;base64,YWRtaXR0ZWQgYnl0ZXM=",
          name: "admitted.txt",
          source: { type: "uri", uri: "file:///original/no-longer-present" },
        }],
      });
      await native.api.experimental.session.wait({
        sessionID: target.nativeID,
      });
      const db = new DatabaseSync(native.db, { readOnly: true });
      resources().defer("history readonly owner", () => db.close());
      let reads = 0;
      const reader = new HistoryReader(() => {
        reads++;
        return db;
      }, cfg().attachments);
      const readers = reader.readers();
      const port: ProviderReadPort = {
        async read<K extends keyof ProviderReadKinds>(
          kind: K,
          input: ProviderReadKinds[K]["input"],
          options: ProviderReadOptions,
        ): Promise<ProviderReadKinds[K]["result"]> {
          const run = readers[kind];
          if (!run) throw new Error("Test read not selected");
          return await run(
            input,
            options.signal ?? new AbortController().signal,
          );
        },
        release: () => {},
      };
      const history = new ProviderHistory(port);
      resources().defer("history facade", () => history.close());
      assertEquals(reads, 0);
      const entries = await history.listHistory(undefined, native.directory);
      assertEquals(entries.length, 1);
      assertEquals(entries[0].input, "Recall this admitted upload");
      const ref = entries[0].parts[0];
      assert(ref.kind === "file" && ref.source === "history");
      assertEquals(ref.name, "admitted.txt");
      assertEquals(ref.size, 14);
      assertFalse(JSON.stringify(entries).includes("YWRtaXR0ZWQgYnl0ZXM="));
      const attachment = await history.attachment(ref);
      assertEquals(attachment.dataBase64, "YWRtaXR0ZWQgYnl0ZXM=");
      const decoder = historyAttachmentCodec.create();
      for (
        const chunk of historyAttachmentCodec.chunks(
          await history.attachments([ref]),
          1,
        )
      ) decoder.append(chunk);
      assertEquals(decoder.finish()[0].part, attachment);
      const headers = arrayReadCodec<typeof entries[number]>().create();
      headers.append(entries);
      assertEquals(headers.finish(), entries);
      await assertRejects(
        () =>
          history.attachments([ref, {
            messageID: ref.messageID,
            partID: "file:999",
          }]),
        OperationFailure,
      );
      const client = new V2Client(
        await discoverV2(native.serviceFile),
        30000,
        new AbortController().signal,
      );
      assertEquals(
        (await client.read((api) =>
          api.session.get({ sessionID: target.nativeID })
        )).id,
        target.nativeID,
      );
    }),
});
