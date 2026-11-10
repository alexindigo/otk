// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { OperationFailure } from "@otk/protocol";
import {
  discoverV2,
  opencodeV2ReadCodecs,
  OpencodeV2ServerAdapter,
  opencodeV2SessionID as ids,
} from "@otk/harness-opencode-v2-server";
import { DigestBridge } from "../../core/digest/bridge.ts";
import { IndexStore } from "../../core/index/store.ts";
import type { HarnessSink, ProjectSeed } from "@otk/harness";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { nativeKind } from "../support/native.ts";
import { resources, withResources } from "../support/resources.ts";
import { cfg } from "../support/config.ts";
import { waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";
import type { InboxBaseline, SessionListPage } from "@otk/protocol";

Deno.test({
  name:
    "OC2I7 saved native worktrees publish exact-scope topology without population acquisition",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 saved topology", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm(), {
        prepare: async (fixture) => {
          const result = await new Deno.Command("git", {
            cwd: fixture.directory,
            args: [
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=fixture@example.test",
              "commit",
              "--allow-empty",
              "-m",
              "Fixture root",
            ],
          }).output();
          assert(result.success, new TextDecoder().decode(result.stderr));
        },
      });
      const root = await native.createSession();
      const raw = await native.api.session.get({ sessionID: root.nativeID });
      const tree = await native.api.worktree.create({
        projectID: raw.projectID,
        directory: native.root + "/trees",
        name: "leaf",
      });
      const nested = tree.directory + "/src";
      await Deno.mkdir(nested);
      const child = await native.api.session.create({
        location: { directory: nested },
        title: "Exact nested scope",
      });
      assertEquals(child.projectID, raw.projectID);
      const settings = cfg(),
        requests: string[] = [],
        seeds: ProjectSeed[] = [];
      const bridge = new DigestBridge({
        reads: opencodeV2ReadCodecs,
        provider: "opencode-v2-server",
        statePath: native.root + "/topology-state",
        native: {
          serviceFile: native.serviceFile,
          db: native.db,
          requestms: settings.harness.requestms,
          attachments: settings.attachments,
        },
        policy: settings.digest,
        publish: () => {},
        diagnostic: () => {},
      });
      const adapter = new OpencodeV2ServerAdapter(
        {
          serviceFile: native.serviceFile,
          harness: settings.harness,
          messages: settings.messages,
        },
        undefined,
        () => {},
        (input, init) => {
          requests.push(
            new URL(input instanceof Request ? input.url : String(input))
              .pathname,
          );
          return fetch(input, init);
        },
        bridge,
      );
      resources().defer("V2 topology adapter", () => adapter.core.stop());
      await adapter.core.start({
        connection: () => {},
        indexReset: () => {},
        indexUpsert: () => {},
        indexRemove: () => {},
        content: () => {},
        invalidate: () => {},
        bootstrapComplete: () => {},
        projectSeeds: (rows) => seeds.push(...rows),
      });
      assertEquals(seeds.find((row) => row.directory === nested), {
        directory: nested,
        hasSessions: true,
        sessionCount: 1,
        lastActivity: child.time.updated,
        authority: "current",
        topology: {
          repoID: raw.projectID,
          canonicalRoot: native.directory,
          leafDirectory: tree.directory,
          parentDirectory: native.directory,
        },
      });
      const empty = seeds.find((row) => row.directory === tree.directory)!;
      assertEquals(
        [empty.hasSessions, empty.sessionCount, empty.lastActivity],
        [false, 0, null],
      );
      assertEquals(empty.topology?.leafDirectory, tree.directory);
      assertEquals(
        seeds.find((row) => row.directory === native.directory)?.topology,
        {
          repoID: raw.projectID,
          canonicalRoot: native.directory,
          leafDirectory: native.directory,
        },
      );
      assertEquals(
        requests.some((path) =>
          path === "/api/session" || path.includes("/message")
        ),
        false,
      );
      const identities = await adapter.core.identities([ids.encode(child.id)]);
      assertEquals(identities[0].directory, nested);
      // The worker itself owns API inventory I/O; verify only its read-only inventory
      // changed no native state after startup and a second inventory read.
      const before = await native.api.worktree.list({
        projectID: raw.projectID,
      });
      const again = await bridge.projects(1, new AbortController().signal);
      assertEquals(
        again.projects.find((row) => row.directory === nested)?.topology,
        empty.topology,
      );
      assertEquals(
        await native.api.worktree.list({ projectID: raw.projectID }),
        before,
      );
      const fallback = new DigestBridge({
        reads: opencodeV2ReadCodecs,
        provider: "opencode-v2-server",
        statePath: native.root + "/topology-fallback",
        native: {
          serviceFile: native.serviceFile,
          db: native.root + "/missing-topology.sqlite",
          requestms: settings.harness.requestms,
          attachments: settings.attachments,
        },
        policy: settings.digest,
        publish: () => {},
        diagnostic: () => {},
      });
      resources().defer("V2 topology fallback", () => fallback.stop());
      await fallback.start();
      const unknown = (await fallback.projects(1, new AbortController().signal))
        .projects.find((row) => row.directory === tree.directory)!;
      assertEquals(unknown.topology, empty.topology);
      assertEquals([
        unknown.hasSessions,
        unknown.sessionCount,
        unknown.lastActivity,
        unknown.authority,
      ], [undefined, null, null, "unknown"]);
      const unknownScope = (await fallback.projects(
        1,
        new AbortController().signal,
        undefined,
        nested,
      )).projects[0];
      assertEquals(
        unknownScope.topology,
        undefined,
        "unknown native ownership cannot retire a previously known nested relationship",
      );
      // A native topology event changes only the relationship, never the exact
      // directory used by identity, list and task scopes.
      await native.api.project.update({
        projectID: raw.projectID,
        canonical: tree.directory,
      });
      await waitFor(() =>
        seeds.findLast((row) => row.directory === nested)?.topology
          ?.canonicalRoot, (root) =>
        root === tree.directory);
      assertEquals(
        seeds.findLast((row) =>
          row.directory === nested
        )?.topology,
        {
          repoID: raw.projectID,
          canonicalRoot: tree.directory,
          leafDirectory: tree.directory,
        },
      );
      assertEquals(
        (await adapter.core.identities([ids.encode(child.id)]))[0].directory,
        nested,
      );
    }),
});

Deno.test({
  name:
    "OC2I1 grouped seeds, worker keyed hydrate and bounded SQL/API lists preserve demand loading",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 scalar index", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm()),
        settings = cfg();
      const roots = [];
      for (let i = 0; i < 43; i++) {
        roots.push(await native.createSession("Indexed " + i));
      }
      const child = await native.api.session.create({
        parentID: roots[0].nativeID,
        title: "helper",
      });
      const grandchild = await native.api.session.create({
        parentID: child.id,
        title: "grandchild",
      });
      const index = new IndexStore(),
        seeds: ProjectSeed[] = [],
        requests: string[] = [];
      const errors: string[] = [];
      const bridge = new DigestBridge({
        reads: opencodeV2ReadCodecs,
        provider: "opencode-v2-server",
        statePath: native.root + "/otk-state",
        native: {
          serviceFile: native.serviceFile,
          db: native.db,
          requestms: settings.harness.requestms,
          attachments: settings.attachments,
        },
        policy: settings.digest,
        metadata: (rows) => {
          for (const row of rows) index.upsertMetadata(row);
        },
        publish: () => {},
        diagnostic: (error) => errors.push(String(error)),
      });
      const adapter = new OpencodeV2ServerAdapter(
        {
          serviceFile: native.serviceFile,
          harness: settings.harness,
          messages: settings.messages,
        },
        await discoverV2(native.serviceFile),
        (error) => errors.push(String(error)),
        async (input, init) => {
          requests.push(
            new URL(input instanceof Request ? input.url : String(input))
              .pathname,
          );
          return await fetch(input, init);
        },
        bridge,
      );
      resources().defer("V2 index adapter", () => adapter.core.stop());
      const sink: HarnessSink = {
        index,
        connection: () => {},
        indexReset: () => {},
        indexUpsert: (row) => index.upsertMetadata(row),
        indexRemove: (id) => index.remove(id),
        content: () => {},
        invalidate: () => {},
        bootstrapComplete: () => {},
        projectSeeds: (rows) => seeds.push(...rows),
      };
      await adapter.core.start(sink);
      assertEquals(
        index.snapshotEntries().length,
        0,
        "startup cannot hydrate idle population",
      );
      assertEquals(
        seeds.find((seed) => seed.directory === native.directory)?.sessionCount,
        45,
      );
      assertEquals(
        requests.filter((path) => path === "/api/session").length,
        0,
      );
      assertEquals(requests.some((path) => path.includes("/message")), false);
      const identity = await adapter.core.identities([
        ids.encode(grandchild.id),
        ids.encode(grandchild.id),
        ids.encode("ses_absent"),
      ]);
      assertEquals(identity, [{
        id: ids.encode(grandchild.id),
        directory: native.directory,
        parentID: ids.encode(child.id),
      }]);
      await adapter.core.hydrate!([
        ids.encode(grandchild.id),
        "opcv1-ses_unproven",
      ]);
      assertEquals(
        index.snapshotEntries().map((row) => row.id).sort(),
        [roots[0].id, ids.encode(child.id), ids.encode(grandchild.id)].sort(),
      );
      const first = await adapter.core.listSessions({
        directory: native.directory,
        parentID: null,
      });
      assertEquals(first.items.length, 20);
      assert(first.older);
      const second = await adapter.core.listSessions({
        directory: native.directory,
        parentID: null,
        before: first.older,
      });
      const third = await adapter.core.listSessions({
        directory: native.directory,
        parentID: null,
        before: second.older!,
      });
      assertEquals(third.items.length, 3);
      assertEquals(third.older, null);
      assertEquals(
        new Set(
          [...first.items, ...second.items, ...third.items].map((row) =>
            row.id
          ),
        ).size,
        43,
      );
      const rejected = await assertRejects(
        () =>
          adapter.core.listSessions({
            directory: native.directory,
            query: "other",
            before: first.older!,
          }),
        OperationFailure,
      );
      assertEquals(rejected.outcome, "rejected");
      assertEquals(
        (await adapter.core.listChildren(roots[0].id)).map((row) => row.id),
        [ids.encode(child.id)],
      );
      assertEquals(errors, [
        "Error: Provider read: The operation has not completed",
      ]);
      // The same demand contract without a usable DB uses native cursor pages.
      const apiOnly = new OpencodeV2ServerAdapter({
        serviceFile: native.serviceFile,
        harness: settings.harness,
        messages: settings.messages,
      });
      resources().defer("V2 API-only adapter", () => apiOnly.core.stop());
      await apiOnly.core.start({
        ...sink,
        index: undefined,
        indexUpsert: () => {},
        projectSeeds: () => {},
      });
      const apiFirst = await apiOnly.core.listSessions({
        directory: native.directory,
        parentID: null,
        limit: 20,
      });
      const apiSecond = await apiOnly.core.listSessions({
        directory: native.directory,
        parentID: null,
        limit: 20,
        before: apiFirst.older!,
      });
      assertEquals(
        new Set([...apiFirst.items, ...apiSecond.items].map((row) => row.id))
          .size,
        40,
      );
      assertEquals(
        apiFirst.items.map((row) => row.id),
        first.items.map((row) => row.id),
      );
    }),
});

Deno.test({
  name:
    "OC2I3 source/compiled consumer sees bounded loading and unattended project lamps",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 index wire consumer", async () => {
      const fake = new FakeLlm();
      fake.queue({ chunks: ["one", "two", "three", "four"], delay: 300 });
      const native = await OpencodeV2Test.start(fake),
        target = await native.createSession();
      const app = await SidecarTest.start(native), ws = new WsClient(app.url);
      await ws.connect();
      const inbox = await ws.rpc<InboxBaseline>("inbox.get", {});
      assertEquals(inbox.inbox.summaries?.[native.directory].sessionCount, 1);
      const page = await ws.rpc<SessionListPage>("sessions.list", {
        directory: native.directory,
        parentID: null,
      });
      assertEquals(page.load.state, "complete");
      assertEquals(page.items.map((row) => row.id), [target.id]);
      assertEquals(page.older, null);
      assert(ws.frames.some((frame) =>
        frame.t === "load.chunk" && frame.load.id === page.load.id &&
        frame.load.state === "loading"
      ));
      // No session subscription, selected transcript or native body acquisition.
      await native.prompt(target.id, "show unattended status");
      const status = async () =>
        (await ws.rpc<InboxBaseline>("inbox.get", {})).inbox.summaries
          ?.[native.directory].status;
      await waitFor(status, (status) =>
        status === "working");
      await waitFor(status, (status) => status === "finished", 30000);
      const final = await ws.rpc<InboxBaseline>("inbox.get", {});
      assertEquals(final.inbox.summaries?.[native.directory].unseenCount, 1);
      // Finish marks are deliberately view-scoped. Acquire only this scalar row
      // after proving the unattended summary, not a selected transcript.
      ws.lease({ directory: native.directory, crumbs: [], rows: [target.id] });
      const scoped = await waitFor(() =>
        ws.rpc<InboxBaseline>("inbox.get", {}), (value) =>
        value.inbox.finishes[target.id] > 0);
      assert(scoped.inbox.finishes[target.id] > 0);
      await ws.close();
    }),
});

Deno.test({
  name:
    "OC2I2 idle pending helper hydrates its complete ancestry and resync clears only complete inventories",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 ancestry attention", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm()),
        settings = cfg();
      const root = await native.createSession(),
        child = await native.api.session.create({
          parentID: root.nativeID,
          title: "helper",
        }),
        grandchild = await native.api.session.create({
          parentID: child.id,
          title: "nested helper",
        });
      const form = await native.api.session.form.create({
        sessionID: grandchild.id,
        title: "pending",
        fields: [{ key: "ok", type: "boolean", title: "OK" }],
      });
      const index = new IndexStore();
      let bootstraps = 0;
      const adapter = new OpencodeV2ServerAdapter({
        serviceFile: native.serviceFile,
        harness: settings.harness,
        messages: settings.messages,
      });
      resources().defer("V2 ancestry adapter", () => adapter.core.stop());
      await adapter.core.start({
        index,
        connection: () => {},
        indexReset: () => {},
        indexUpsert: (row) => index.upsertMetadata(row),
        indexRemove: (id) => index.remove(id),
        content: () => {},
        invalidate: () => {},
        bootstrapComplete: () => {
          bootstraps++;
        },
      });
      assertEquals(
        index.getMetadata(ids.encode(grandchild.id))?.attention.questions,
        1,
      );
      assertEquals(index.ancestors(ids.encode(grandchild.id)), [
        ids.encode(child.id),
        root.id,
      ]);
      native.proxy.disconnect();
      await waitFor(() => bootstraps, (n) => n === 2);
      assertEquals(
        index.getMetadata(ids.encode(grandchild.id))?.attention.questions,
        1,
      );
      await native.api.session.form.reply({
        sessionID: grandchild.id,
        formID: form.id,
        answer: { ok: true },
      });
      await waitFor(
        () => index.getMetadata(ids.encode(grandchild.id))?.attention.questions,
        (n) => n === 0,
      );
    }),
});

Deno.test({
  name:
    "OC2I4 missing DB publishes unknown population and uses authoritative API identity/list fallback",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 scalar fallback", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm()),
        older = await native.createSession(),
        target = await native.createSession(),
        settings = cfg();
      const bridge = new DigestBridge({
        reads: opencodeV2ReadCodecs,
        provider: "opencode-v2-server",
        statePath: native.root + "/fallback-state",
        native: {
          serviceFile: native.serviceFile,
          db: native.root + "/missing.sqlite",
          requestms: 1000,
          attachments: settings.attachments,
        },
        policy: settings.digest,
        publish: () => {},
        diagnostic: () => {},
      });
      resources().defer("V2 fallback bridge", () => bridge.stop());
      await bridge.start();
      const signal = new AbortController().signal;
      const projects = (await bridge.projects(1, signal)).projects;
      const seed = projects.find((p) => p.directory === native.directory)!;
      assertEquals([
        seed.hasSessions,
        seed.sessionCount,
        seed.lastActivity,
        seed.authority,
      ], [undefined, null, null, "unknown"]);
      assertEquals(
        await bridge.read("identity.batch", { ids: [target.id] }, {
          owner: "fallback-id",
          priority: "user",
          signal,
        }),
        [{ id: target.id, directory: native.directory }],
      );
      const list = await bridge.read("sessions.list", {
        directory: native.directory,
        limit: 1,
      }, { owner: "fallback-list", priority: "user", signal });
      assertEquals(list.items.map((row) => row.id), [target.id]);
      assert(list.older);
      const terminal = await bridge.read("sessions.list", {
        directory: native.directory,
        limit: 1,
        before: list.older,
      }, { owner: "fallback-terminal", priority: "user", signal });
      // Activity-sorted API fallback proves terminal pages with lookahead;
      // use two rows to retain a real continuation rather than an empty probe.
      assertEquals(terminal.items.map((row) => row.id), [older.id]);
      assertEquals(terminal.older, null);
      await native.stop();
      const failure = await assertRejects(() =>
        bridge.read("identity.batch", { ids: [target.id] }, {
          owner: "offline-id",
          priority: "user",
          signal,
        }), OperationFailure);
      assertEquals(failure.outcome, "unavailable");
    }),
});

Deno.test({
  name:
    "OC2I5 an execution completed during bootstrap retains exactly one finish edge",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 bootstrap finish", async () => {
      const fake = new FakeLlm();
      fake.queue({ chunks: ["completed during bootstrap"] });
      const native = await OpencodeV2Test.start(fake),
        target = await native.createSession(),
        settings = cfg();
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let held = false;
      resources().defer("bootstrap read hold", () => release.resolve());
      const index = new IndexStore();
      let finishes = 0,
        bootstraps = 0,
        failTerminal = false,
        terminalRead = false,
        readFailures = 0;
      index.observe((entry, previous) => {
        if (
          entry.id === target.id && previous?.status === "busy" &&
          entry.status === "idle"
        ) finishes++;
      });
      const adapter = new OpencodeV2ServerAdapter(
        {
          serviceFile: native.serviceFile,
          harness: settings.harness,
          messages: settings.messages,
        },
        undefined,
        () => {},
        async (input, init) => {
          const response = await fetch(input, init),
            url = new URL(input instanceof Request ? input.url : String(input));
          if (url.pathname === "/api/debug/location" && !held) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          if (
            terminalRead && url.pathname === `/api/session/${target.nativeID}`
          ) {
            failTerminal = false;
            readFailures++;
            await response.body?.cancel();
            throw new TypeError("fixture terminal metadata read failed");
          }
          return response;
        },
      );
      const apply = adapter.stream.ports.event;
      adapter.stream.ports.event = async (...args) => {
        terminalRead = failTerminal &&
          /^session\.execution\.(succeeded|failed|interrupted)$/.test(
            args[0].type,
          );
        try {
          await apply(...args);
        } finally {
          terminalRead = false;
        }
      };
      resources().defer("bootstrap finish adapter", () => adapter.core.stop());
      const starting = adapter.core.start({
        index,
        connection: () => {},
        indexReset: () => {},
        indexUpsert: (entry) => index.upsertMetadata(entry),
        indexRemove: (id) => index.remove(id),
        content: () => {},
        invalidate: () => {},
        bootstrapComplete: () => {
          bootstraps++;
        },
      });
      const failure = starting.catch((error) => {
        release.resolve();
        throw error;
      });
      await entered.promise;
      await native.prompt(target.id, "finish while snapshot read is held");
      await waitFor(
        () => native.api.session.get({ sessionID: target.nativeID }),
        (row) => !!row.time.idle,
        30000,
      );
      release.resolve();
      await failure;
      await waitFor(() => index.getMetadata(target.id)?.status, (status) =>
        status === "idle");
      assertEquals(finishes, 1);
      fake.queue({ chunks: ["finish", "while disconnected"], delay: 100 });
      await native.prompt(target.id, "finish before reconnect snapshot");
      await waitFor(() =>
        index.getMetadata(target.id)?.status, (status) =>
        status === "busy");
      native.proxy.disconnect();
      await waitFor(() =>
        bootstraps, (count) =>
        count === 2);
      assertEquals(index.getMetadata(target.id)?.status, "idle");
      assertEquals(finishes, 2, "reconnect must settle the matching run once");
      failTerminal = true;
      fake.queue({
        chunks: ["finish", "with metadata I/O failure"],
        delay: 100,
      });
      await native.prompt(target.id, "preserve the lost-run resync key");
      await waitFor(() => bootstraps, (count) => count === 3);
      assertEquals(readFailures, 1);
      assertEquals(index.getMetadata(target.id)?.status, "idle");
      assertEquals(
        finishes,
        3,
        "terminal read failure cannot erase the resync key",
      );
    }),
});

Deno.test({
  name:
    "OC2I6 explicit pending settlement survives failed and stale location inventories",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 pending authority", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm()),
        target = await native.createSession(),
        settings = cfg();
      const form = await native.api.session.form.create({
        sessionID: target.nativeID,
        title: "settle once",
        fields: [{ key: "ok", type: "boolean", title: "OK" }],
      });
      const permissionOutcome = native.nativeApi.permission.create({
        sessionID: target.nativeID,
        action: "shell",
        resources: ["echo pending authority"],
      }).then(() => true, () => false);
      const permissions = await waitFor(
        () => native.nativeApi.permission.list({ sessionID: target.nativeID }),
        (rows) => rows.length === 1,
      );
      const index = new IndexStore();
      let bootstraps = 0, unavailable = 0, staleReads = 0;
      let inventory: "native" | "fail" | "stale" = "native";
      const adapter = new OpencodeV2ServerAdapter(
        {
          serviceFile: native.serviceFile,
          harness: settings.harness,
          messages: settings.messages,
        },
        undefined,
        (error) => {
          if (error instanceof OperationFailure) unavailable++;
        },
        (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );
          if (url.pathname === "/api/form" && inventory === "fail") {
            return Promise.resolve(
              Response.json({
                _tag: "Unavailable",
                message: "fixture inventory unavailable",
              }, { status: 503 }),
            );
          }
          if (url.pathname === "/api/form" && inventory === "stale") {
            staleReads++;
            return Promise.resolve(
              Response.json({
                location: { directory: native.directory },
                data: [form],
              }),
            );
          }
          return fetch(input, init);
        },
      );
      resources().defer("pending authority adapter", () => adapter.core.stop());
      await adapter.core.start({
        index,
        connection: () => {},
        indexReset: () => {},
        indexUpsert: (entry) => index.upsertMetadata(entry),
        indexRemove: (id) => index.remove(id),
        content: () => {},
        invalidate: () => {},
        bootstrapComplete: () => {
          bootstraps++;
        },
      });
      assertEquals(index.getMetadata(target.id)?.attention.questions, 1);
      assertEquals(index.getMetadata(target.id)?.attention.permissions, 1);
      inventory = "fail";
      native.proxy.freeze();
      native.proxy.disconnect();
      await native.nativeApi.permission.reply({
        sessionID: target.nativeID,
        requestID: permissions[0].id,
        decision: "once",
      });
      assertEquals(await permissionOutcome, true);
      native.proxy.thaw();
      await waitFor(() => bootstraps, (count) => count === 2);
      assertEquals(index.getMetadata(target.id)?.attention.questions, 1);
      assertEquals(
        index.getMetadata(target.id)?.attention.permissions,
        0,
        "a complete permission inventory is independent of an unavailable form inventory",
      );
      assertEquals(index.getMetadata(target.id)?.activityAuthority, "unknown");
      await native.api.session.form.reply({
        sessionID: target.nativeID,
        formID: form.id,
        answer: { ok: true },
      });
      await waitFor(
        () => index.getMetadata(target.id)?.attention.questions,
        (count) => count === 0,
      );
      // Keyed settlement publishes before the inventory I/O diagnostic settles.
      await waitFor(() => unavailable, (count) => count === 2);
      assertEquals(unavailable, 2);
      inventory = "stale";
      native.proxy.disconnect();
      await waitFor(() => bootstraps, (count) => count === 3);
      assertEquals(
        index.getMetadata(target.id)?.attention.questions,
        0,
        "a stale snapshot cannot resurrect an explicitly settled request",
      );
      assert(staleReads > 0);
      assertEquals(
        unavailable,
        2,
        "stale inventory must decode successfully, not masquerade as unavailable",
      );
    }),
});
