// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  consumeEvents,
  OpencodeV1Adapter,
  opencodeV1ReadCodecs,
} from "@otk/harness-opencode-v1";
import { DigestBridge } from "../../core/digest/bridge.ts";
import { catalogConsumer } from "../reuse/directory-catalogs-consumer.ts";
import { cfg } from "../support/config.ts";
import { tempDir, test } from "../support/resources.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";

test("independent directory catalog consumer shares complete native values, watches files only, and renews on native restart", async () => {
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake, {}, {
    config: {
      agent: {
        observer: {
          mode: "primary",
          color: "#123456",
          description: "Observe the catalog",
          prompt: "PRIVATE CATALOG PROMPT",
        },
      },
    },
    async prepare(oc) {
      await Deno.writeTextFile(
        join(oc.directory, ".gitignore"),
        ".opencode/\nignored/\n",
      );
      await Deno.mkdir(join(oc.directory, "catalog"));
      await Deno.mkdir(join(oc.directory, "ignored"));
      await Deno.writeTextFile(
        join(oc.directory, "ignored/secret.txt"),
        "Not an ordinary discovery candidate",
      );
      await Deno.symlink(oc.directory, join(oc.directory, "catalog/cycle"));
      for (let i = 0; i < 230; i++) {
        await Deno.writeTextFile(
          join(oc.directory, `catalog/candidate-${i}.txt`),
          "PRIVATE FILE CONTENT",
        );
      }
    },
  });
  const settings = cfg();
  settings.harness.url = oc.url;
  settings.harness.db = oc.db;
  settings.digest.cpu = 1;
  const calls: URL[] = [];
  const eventController = new AbortController();
  const nativeEvents: unknown[] = [];
  const eventResponse = await fetch(oc.url + "/global/event", {
    signal: eventController.signal,
  });
  const eventCapture = consumeEvents(eventResponse, () => {}, (event) => {
    if (
      ["catalog.updated", "integration.updated", "reference.updated"].includes(
        event.payload.type,
      )
    ) nativeEvents.push(event);
  }).then(
    () => undefined,
    (error: unknown) => ({ error, cancelled: eventController.signal.aborted }),
  );
  const stopCapture = async () => {
    eventController.abort();
    const failure = await eventCapture;
    if (failure && !failure.cancelled) throw failure.error;
  };
  // Complete native instance initialization before measuring shared OTK acquisition.
  for (
    const path of [
      "/agent",
      "/config/providers",
      "/command",
      "/skill",
      "/experimental/resource",
    ]
  ) await oc.request(path);
  const adapter = catalogConsumer(settings, (input, options) => {
    calls.push(new URL(String(input)));
    return fetch(input, options);
  });
  let connections = 0;
  const lease = adapter.catalogs.acquire(oc.directory);
  try {
    // Measure independent shared acquisition before enabling genuine stream invalidations.
    const session = await adapter.core.createSession({
      directory: oc.directory,
      title: "Catalog consumer",
    });
    const [agents, models, commands, skills, resources, files] = await Promise
      .all([
        lease.get("agents"),
        lease.get("models"),
        lease.get("commands"),
        lease.get("skills"),
        lease.get("resources"),
        lease.get("files"),
      ]);
    assert(
      agents.some((agent) =>
        agent.name === "observer" && agent.color === "#123456"
      ),
    );
    assert(!JSON.stringify(agents).includes("PRIVATE CATALOG PROMPT"));
    assert(models.providers.some((provider) => provider.id === "fake"));
    assert(
      Array.isArray(commands) && Array.isArray(skills) &&
        Array.isArray(resources),
    );
    assert(files.some((file) => file.path === "catalog/candidate-229.txt"));
    assertEquals(
      files.filter((file) => file.path.startsWith("catalog/candidate-")).length,
      230,
    );
    assert(
      !files.some((file) =>
        file.path.startsWith("ignored/") || file.path.includes("cycle")
      ),
    );
    assert(!JSON.stringify(files).includes("PRIVATE FILE CONTENT"));
    await adapter.capabilities.agents!.listAgents(session.id, true);
    await adapter.capabilities.agents!.listAgents(session.id, false);
    await adapter.capabilities.models!.listModels(session.id);
    await adapter.capabilities.commands!.listCommands(session.id);
    assertEquals(calls.filter((url) => url.pathname === "/agent").length, 1);
    assertEquals(
      calls.filter((url) => url.pathname === "/config/providers").length,
      1,
    );
    assertEquals(calls.filter((url) => url.pathname === "/skill").length, 1);
    assertEquals(
      calls.filter((url) =>
        url.pathname === "/find/file" || url.pathname === "/file/content"
      ).length,
      0,
    );
    const originalAgentReads = calls.filter((url) =>
      url.pathname === "/agent"
    ).length;
    await Deno.writeTextFile(
      join(oc.directory, "opencode.json"),
      JSON.stringify({
        agent: {
          reloaded: {
            mode: "primary",
            description: "Reported after native reload",
          },
        },
      }),
    );
    await Deno.writeTextFile(
      join(oc.directory, "catalog/new-file.txt"),
      "NEW PRIVATE CONTENT",
    );
    await waitFor(() => lease.get("files"), (items) =>
      items.some((item) => item.path === "catalog/new-file.txt"));
    assertEquals(
      calls.filter((url) =>
        url.pathname === "/agent"
      ).length,
      originalAgentReads,
      "Filesystem changes never refresh configuration catalogs",
    );
    assert(
      !(await lease.get("agents")).some((agent) => agent.name === "reloaded"),
    );
    await adapter.core.start({
      connection(state) {
        if (state === "connected") connections++;
      },
      indexReset() {},
      indexUpsert() {},
      indexRemove() {},
      content() {},
      bootstrapComplete() {},
      invalidate() {},
    });
    await waitFor(() => connections, (value) => value === 1);
    assert(
      !(await lease.get("agents")).some((agent) => agent.name === "reloaded"),
    );
    const generation = lease.snapshot().generation;
    await stopCapture();
    // The test owns this idle fixture server's lifecycle; OTK performs no reload/disposal.
    await oc.restart();
    await waitFor(() => connections, (value) => value === 2);
    await waitFor(
      () => lease.get("agents"),
      (items) => items.some((item) => item.name === "reloaded"),
    );
    assert(lease.snapshot().generation !== generation);
    assertEquals(
      calls.filter((url) =>
        url.pathname === "/instance/dispose" ||
        url.pathname === "/global/dispose"
      ).length,
      0,
    );
  } finally {
    await stopCapture();
    await Deno.writeTextFile(
      join(oc.root, "catalog-events.json"),
      JSON.stringify(nativeEvents, null, 2),
    );
    lease.release();
    await adapter.core.stop();
    await oc.stop();
    await fake.stop();
  }
});

test("selected worker catalog contributions publish complete values through bounded transient chunks", async () => {
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake, {}, {
    prepare: (oc) =>
      Deno.writeTextFile(join(oc.directory, ".gitignore"), ".opencode/\n"),
  });
  const settings = cfg();
  settings.harness.url = oc.url;
  settings.harness.db = oc.db;
  settings.digest.cpu = 1;
  settings.digest.publishrows = 1;
  const bridge = new DigestBridge({
    statePath: await tempDir("catalog-worker-"),
    provider: "opencode-v1",
    native: settings,
    policy: settings.digest,
    reads: opencodeV1ReadCodecs,
    publish() {},
  });
  const adapter = new OpencodeV1Adapter(settings, undefined, fetch, bridge);
  const lease = adapter.catalogs.acquire(oc.directory);
  try {
    const [agents, models, files] = await Promise.all([
      lease.get("agents"),
      lease.get("models"),
      lease.get("files"),
    ]);
    assert(agents.some((agent) => agent.name === "build"));
    assert(
      models.providers.some((provider) =>
        provider.id === "fake" &&
        provider.models.some((model) => model.id === "scripted")
      ),
    );
    assert(files.some((file) => file.path === "README.md"));
    assertEquals(models.default, { provider: "fake", model: "scripted" });
  } finally {
    lease.release();
    await adapter.core.stop();
    await bridge.stop();
    await oc.stop();
    await fake.stop();
  }
});
