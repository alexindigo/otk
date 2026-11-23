// SPDX-License-Identifier: LGPL-3.0-only
import { knownDerived } from "@otk/protocol";
import { join } from "@std/path";
import { inboxBrowserFixture } from "./inbox-browser.ts";
import { fixture } from "./config.ts";
import { resources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { consumerAssets } from "./consumer-builds.ts";
import { sessionsCoreScenario } from "./sessions-core-scenario.ts";
import { registerSessionActions, registerUsage } from "../../core/mod.ts";
import {
  type AssistantMessage,
  type Message,
  OperationFailure,
  type TaskRecord,
  usageHeader,
  UsageLedger,
} from "@otk/protocol";
import { createTabs } from "@otk/client";
import { publishUsage, turnDetail } from "./usage-summary.ts";
import type {
  ControlRequest,
  Json,
  Profile,
  TestLease,
} from "./fixture-control.ts";

/** Original external-backend compositions, with bounded scenario controls. */
export async function sessionsScenario(profile: Profile) {
  if (
    [
      "contract-sessions-direct",
      "contract-sessions-resurrection",
      "contract-sessions-unknown",
      "contract-sessions-summary",
      "contract-sessions-progress",
    ].includes(profile)
  ) return await sessionsCoreScenario(profile);
  const root = await fixture();
  const messages: Record<string, Message[]> =
    profile === "contract-sessions-tabs"
      ? {
        "tstv1-otk": [{
          id: "reply",
          sessionID: "tstv1-otk",
          role: "assistant",
          time: { created: 1, completed: 2 },
          agent: "build",
          model: { provider: "test", model: "test" },
          tokens: {
            input: 2000,
            output: 100,
            reasoning: 20,
            cache: { read: 500, write: 50 },
          },
          cost: .125,
          interrupted: false,
          parts: [],
        }],
      }
      : {};
  const f = await inboxBrowserFixture(
    root,
    [],
    messages,
    profile === "contract-sessions-panel"
      ? await consumerAssets("panel")
      : undefined,
  );
  const c = new WsClient(f.url);
  await c.connect(f.entries[0].directory, f.entries[0].id);
  resources().defer("sessions control client", () => c.close());
  const gate = Promise.withResolvers<void>();
  resources().defer("sessions creation gate", () => gate.resolve());
  let creates = 0;
  let rejectRename = true;
  let remote: Awaited<ReturnType<typeof inboxBrowserFixture>> | undefined;
  if (profile === "contract-sessions-merge") {
    remote = await inboxBrowserFixture(join(root, "second"), [f.url]);
    for (const owner of [f, remote]) {
      const client = owner === f ? c : new WsClient(owner.url);
      if (client !== c) await client.connect(owner.entries[0].directory);
      for (const entry of owner.entries.slice(0, 4)) {
        await client.rpc("projects.visit", {
          directory: entry.directory,
          active: true,
        });
      }
      if (client !== c) await client.close();
    }
  }
  if (profile === "contract-sessions-window") {
    Object.assign(f.app.backend.capabilities, {
      sessionActions: {
        async rename(id: string, title: string) {
          if (rejectRename) {
            throw new OperationFailure(
              "rejected",
              "request.params",
              new Error("Rename refused; keep the edited title and try again."),
            );
          }
          f.update(id, { title });
          return await f.app.backend.core.getSession(id);
        },
        remove: async () => {},
        fork: (id: string) => f.app.backend.core.getSession(id),
        compact: async () => {},
      },
    });
    registerSessionActions(f.app.connections.rpc, f.app.backend);
  }
  if (profile === "contract-sessions-membership") {
    const create = f.app.backend.core.createSession;
    f.app.backend.core.createSession = async (input) => {
      creates++;
      await gate.promise;
      return await create(input);
    };
  }
  const base = f.entries[0];
  if (profile === "contract-sessions-tab-groups") {
    f.update(base.id, {
      title:
        "Main task: one trail belongs to one group, never to every other task in the project",
    });
    for (
      const [id, title] of [["a", "Explore group A"], ["b", "Review group B"], [
        "quiet",
        "Quiet child",
      ]]
    ) {
      f.add({
        ...base,
        id: `tstv1-group-${id}`,
        parentID: id === "b" ? undefined : base.id,
        title,
      });
    }
  }
  if (profile === "contract-sessions-tabs") {
    const ledger = new UsageLedger(
      base.id,
      messages[base.id].filter((m): m is AssistantMessage =>
        m.role === "assistant"
      ).map(usageHeader),
    );
    Object.assign(f.app.backend.capabilities, {
      usage: {
        getUsage: (_id: string, turnID: string) =>
          Promise.resolve(turnDetail(ledger.snapshot(), turnID)),
      },
    });
    registerUsage(f.app.connections.rpc, f.app.backend);
    publishUsage(f.app.index, ledger.snapshot());
  }
  await Deno.mkdir(join(root, "empty-project"));
  if (profile === "contract-sessions-window") {
    // Stable, explicit recency preserves the measured row order under paging.
    base.timeUpdated = 1000;
    f.update(base.id, {});
    for (let i = 0; i < 300; i++) {
      f.add({
        ...base,
        id: `tstv1-w-${i}`,
        title: `Window session ${String(i).padStart(3, "0")}`,
        timeUpdated: 301 - i,
      });
    }
    f.add({
      ...base,
      id: "tstv1-helper",
      parentID: "tstv1-w-10",
      title: "Nested search target",
    });
    for (
      const [id, cost] of [["tstv1-w-299", .125], ["tstv1-w-0", 0]] as const
    ) {
      f.app.index.applyDigest({
        id,
        revision: 1,
        summary: {
          state: "ready",
          revision: 1,
          total: knownDerived(
            {
              calls: 1,
              cost,
              tokens: {
                input: 10,
                output: 2,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              contextPeak: 10,
            },
            "fixture",
            1,
          ),
        },
        turns: { upsert: {}, remove: [] },
        deleted: null,
      });
    }
  }
  if (profile === "contract-sessions-tabs") {
    f.add({ ...base, id: "tstv1-second", title: "After review" });
    f.add({
      ...base,
      id: "tstv1-helper",
      parentID: base.id,
      title: "explore: callers",
    });
    f.add({
      ...base,
      id: "tstv1-nested",
      parentID: "tstv1-helper",
      title: "Inspect caller",
    });
    for (let i = 0; i < 9; i++) {
      f.add({
        ...base,
        id: `tstv1-chain-${i}`,
        title: `tstv1-chain-${i}`,
        parentID: i === 0 ? base.id : `tstv1-chain-${i - 1}`,
      });
    }
  }
  if (
    profile === "contract-sessions-worktrees" ||
    profile === "contract-sessions-removed"
  ) {
    const one = join(root, "worktrees", "feature-one");
    const two = join(root, "worktrees", "feature-two");
    const archived = join(root, "worktrees", "archived-tree");
    for (const [i, directory] of [one, two, archived].entries()) {
      const scope = i === 0 ? join(directory, "src") : directory;
      await Deno.mkdir(scope, { recursive: true });
      f.add({
        ...base,
        id: `tstv1-worktree-${i}`,
        directory: scope,
        title: `Worktree ${i}`,
      });
    }
    const nested = join(one, "src");
    f.add({
      ...base,
      id: "tstv1-worktree-task",
      directory: nested,
      title: "Nested task member",
    });
    f.app.index.projectSeeds(
      [base.directory, one, two, archived, nested].map((directory) => ({
        directory,
        hasSessions: directory !== one,
        sessionCount: directory === one ? 0 : directory === nested ? 2 : 1,
        lastActivity: 1,
        authority: "current" as const,
        presentation: {
          id: base.projectID,
          name: "Fixture project",
          color: "#628cba",
        },
        ...(profile === "contract-sessions-removed"
          ? {
            identities: [{
              source: "worktree-fixture",
              repoID: base.projectID,
              canonicalRoot: base.directory,
              recordedRoot: directory === nested ? one : directory,
              inventory: [base.directory, one, two, archived].map((
                directory,
              ) => ({ directory, kind: "worktree" as const })),
            }],
          }
          : {}),
        topology: {
          repoID: base.projectID,
          canonicalRoot: base.directory,
          leafDirectory: directory === nested ? one : directory,
          ...(directory !== base.directory
            ? { parentDirectory: base.directory }
            : {}),
        },
      })),
    );
    f.app.index.projectAuthority("current");
    for (const directory of [base.directory, one, two, archived]) {
      await c.rpc("projects.visit", { directory, active: true });
    }
    const task = await c.rpc<TaskRecord>("tasks.create", {
      directory: nested,
      name: "Nested task",
    });
    await c.rpc("tasks.addSession", {
      id: task.id,
      sessionID: "tstv1-worktree-task",
    });
    await c.rpc("projects.inactive", { directory: archived, inactive: true });
    f.update("tstv1-worktree-0", { status: "busy" });
    if (profile === "contract-sessions-removed") {
      f.app.index.projectSeeds(
        [base.directory, one, two, archived, nested].map((directory) => ({
          directory,
          hasSessions: directory !== one,
          sessionCount: directory === one ? 0 : directory === nested ? 2 : 1,
          lastActivity: 1,
          authority: "current" as const,
          presentation: {
            id: base.projectID,
            name: "Fixture project",
            color: "#628cba",
          },
          identities: [{
            source: "worktree-fixture",
            repoID: base.projectID,
            canonicalRoot: base.directory,
            recordedRoot: null,
            inventory: [base.directory, archived].map((directory) => ({
              directory,
              kind: "checkout" as const,
            })),
          }],
        })),
      );
    }
  }
  if (profile === "contract-sessions-catalog") {
    const projects = join(root, "projects"),
      worktree = join(projects, "linked"),
      metadata = join(projects, "otk", ".git", "worktrees", "linked");
    await Deno.mkdir(join(projects, "empty"));
    await Deno.mkdir(join(projects, "finished-discovery"));
    f.add({
      ...base,
      id: "tstv1-discovered-finish",
      directory: join(projects, "finished-discovery"),
      title: "Unseen discovery",
    });
    await Deno.mkdir(worktree);
    await Deno.mkdir(metadata, { recursive: true });
    await Deno.writeTextFile(join(metadata, "commondir"), "../..\n");
    await Deno.writeTextFile(
      join(metadata, "gitdir"),
      join(worktree, ".git") + "\n",
    );
    await Deno.writeTextFile(join(worktree, ".git"), `gitdir: ${metadata}\n`);
    await c.rpc("projects.visit", { directory: base.directory, active: true });
    await c.rpc("projects.visit", {
      directory: f.entries[3].directory,
      active: true,
    });
    await c.rpc("projects.inactive", {
      directory: f.entries[3].directory,
      inactive: true,
    });
    await c.rpc("projects.templates", {
      templates: [join(projects, "{project}")],
    });
  }
  if (profile === "contract-sessions-membership") {
    f.add({ ...base, id: "tstv1-kept", title: "Kept session" });
    f.add({ ...base, id: "tstv1-added", title: "Concurrent addition" });
  }
  if (profile === "contract-sessions-memory") {
    f.add({ ...base, id: "tstv1-remembered", title: "Last session" });
    // The fallback is the newest root, independently of a remembered location.
    f.update(base.id, {});
  }
  if (profile === "contract-sessions-default") {
    const nested = join(base.directory, "src");
    await Deno.mkdir(nested, { recursive: true });
    f.add({
      ...base,
      id: "tstv1-remembered-child",
      parentID: base.id,
      title: "Remembered helper",
      timeUpdated: 10,
    });
    f.add({
      ...base,
      id: "tstv1-urgent-child",
      parentID: base.id,
      title: "Needs your answer",
      timeUpdated: 20,
    });
    f.add({
      ...base,
      id: "tstv1-newest-root",
      directory: nested,
      title: "Newest top-level session",
      timeUpdated: Date.now() + 1000,
    });
    f.app.index.projectSeeds([base.directory, nested].map((directory) => ({
      directory,
      sessionCount: 4,
      lastActivity: 1,
      authority: "current" as const,
      topology: {
        repoID: base.projectID,
        canonicalRoot: base.directory,
        leafDirectory: base.directory,
      },
    })));
    f.app.index.projectAuthority("current");
  }
  if (profile === "contract-sessions-family") {
    const directory = join(root, "worktrees", "family");
    await Deno.mkdir(directory, { recursive: true });
    for (const [n, scope] of [directory, base.directory].entries()) {
      f.add({
        ...base,
        id: `tstv1-family-${n}`,
        directory: scope,
        parentID: base.id,
        title: n ? "Local sibling" : "Moved child",
      });
    }
    f.app.index.projectSeeds([base.directory, directory].map((scope) => ({
      directory: scope,
      hasSessions: true,
      sessionCount: scope === directory ? 1 : 2,
      lastActivity: 1,
      authority: "current" as const,
      topology: {
        repoID: base.projectID,
        canonicalRoot: base.directory,
        leafDirectory: scope,
        ...(scope === directory ? { parentDirectory: base.directory } : {}),
      },
    })));
    f.app.index.projectAuthority("current");
    await c.rpc("tasks.create", {
      directory: base.directory,
      name: "Parent task",
      sessions: [base.id],
    });
    f.update("tstv1-family-0", { status: "busy" });
  }
  if (profile === "contract-sessions-hierarchy") {
    f.add({
      ...base,
      id: "tstv1-helper",
      parentID: base.id,
      title: "Explore callers",
    });
    f.add({
      ...base,
      id: "tstv1-nested",
      parentID: "tstv1-helper",
      title: "Find references",
    });
    f.add({ ...base, id: "tstv1-preview", title: "Idle preview" });
    f.add({
      ...base,
      id: "tstv1-blocked",
      title: "Needs answer",
      attention: { ...base.attention, questions: 1 },
    });
    f.add({ ...base, id: "tstv1-finished", title: "Unseen finish" });
    f.update(base.id, { status: "busy" });
    f.update("tstv1-finished", { status: "busy" });
    f.update("tstv1-finished", { status: "idle" });
  }
  if (profile === "contract-sessions-axiom") {
    for (let i = 0; i < 100; i++) {
      f.add({
        ...base,
        id: `tstv1-axiom-${i}`,
        title: `Quiet ${i}`,
        timeUpdated: 101 - i,
      });
    }
  }
  if (profile === "contract-sessions-phantom") {
    for (
      const name of [
        "preview-a",
        "preview-b",
        "pin",
        "double",
        "send",
        "blocked",
        "finished",
      ]
    ) {
      f.add({ ...base, id: `tstv1-${name}`, title: name });
    }
  }
  if (profile === "contract-sessions-close") {
    f.add({ ...base, id: "tstv1-second", title: "Review session" });
    f.add({
      ...base,
      id: "tstv1-child",
      parentID: base.id,
      title: "Helper session",
    });
  }
  if (profile === "contract-sessions-sidebar") {
    const seeds: import("@otk/harness").ProjectSeed[] = [];
    for (
      const mode of [
        "empty",
        "all-required",
        "archive-only",
        "missing-root",
        "mixed",
        "large",
      ]
    ) {
      const canonicalRoot = join(root, "sidebar", mode);
      const count = mode === "large" ? 40 : mode === "empty" ? 0 : 2;
      const paths = [
        canonicalRoot,
        ...Array.from(
          { length: count },
          (_, n) => join(root, "sidebar", `${mode}-child-${n}`),
        ),
      ];
      for (const [n, directory] of paths.entries()) {
        if (mode === "missing-root" && n === 0) continue;
        await Deno.mkdir(directory, { recursive: true });
        const id = `tstv1-sidebar-${mode}-${n}`;
        f.add({
          ...base,
          id,
          projectID: `sidebar-${mode}`,
          directory,
          status: mode === "all-required" && n > 0 ? "busy" : "idle",
          title: `${mode} session ${n}`,
        });
        seeds.push({
          directory,
          hasSessions: true,
          sessionCount: 1,
          lastActivity: 1,
          authority: "current",
          presentation: {
            id: `sidebar-${mode}`,
            name: `${mode} ${n}`,
            color: "#628cba",
          },
          topology: {
            repoID: `sidebar-${mode}`,
            canonicalRoot,
            leafDirectory: directory,
            ...(n > 0 ? { parentDirectory: canonicalRoot } : {}),
          },
          identities: [{
            source: "sidebar-fixture",
            repoID: `sidebar-${mode}`,
            canonicalRoot,
            recordedRoot: directory,
            inventory: paths.map((directory, i) => ({
              directory,
              kind: i > 0 ? "worktree" : "checkout",
            })),
          }],
        });
        await c.rpc("projects.visit", { directory, active: true });
        if (mode === "mixed" && n === 2) {
          await c.rpc("projects.inactive", { directory, inactive: true });
        }
      }
    }
    f.app.index.projectSeeds(seeds);
    f.app.index.projectAuthority("current");
    f.app.index.projectSeeds(
      seeds.filter((seed) =>
        seed.topology?.canonicalRoot.endsWith("archive-only")
      ).map((seed) => ({
        ...seed,
        identities: [{
          source: "sidebar-fixture",
          repoID: seed.topology!.repoID,
          canonicalRoot: seed.topology!.canonicalRoot,
          recordedRoot: null,
          inventory: [{
            directory: seed.topology!.canonicalRoot,
            kind: "checkout" as const,
          }],
        }],
      })),
    );
  }
  await c.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  const baseline = await c.rpc<Record<string, Json>>("prefs.get", {});
  let lease: TestLease | undefined;
  const info = {
    root,
    url: f.url,
    nativeUrl: "",
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [Number(new URL(f.url).port)],
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign sessions lease");
      switch (frame.command) {
        case "beginTest":
          if (lease) throw new Error("Already leased");
          lease = {
            lease: crypto.randomUUID(),
            directory: base.directory,
            baseline,
          };
          return lease;
        case "endTest":
          gate.resolve();
          lease = undefined;
          return null;
        case "observe":
          return {
            entries: f.entries,
            frames: c.frames,
            requests: [],
            creates,
            root,
            remoteUrl: remote?.url,
            remoteEntries: remote?.entries,
          };
        case "productRpc":
          return await c.rpc(frame.params.method, frame.params.params);
        case "writeProjectFiles":
          for (const [name, text] of Object.entries(frame.params.files)) {
            if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
              throw new Error("Invalid owned path");
            }
            await Deno.writeTextFile(join(base.directory, name), text);
          }
          return null;
        case "scenario": {
          const { action, sessionID: id } = frame.params;
          if (
            frame.params.target === "trail-delivery" && id &&
            action === "release"
          ) {
            const entry = f.entries.find((entry) => entry.id === id)!;
            f.update(id, {
              activity: {
                ...entry.activity,
                delivered: {
                  parentID: entry.parentID!,
                  receipt: `result:${id}`,
                  terminal: entry.activity!.terminal!,
                },
              },
            });
            return null;
          }
          if (
            profile === "contract-sessions-tab-groups" &&
            frame.params.target === "trail-decisions"
          ) {
            f.update(base.id, { title: "comm#ark | main" });
            const running = (id: string) => ({
              work: {
                fresh: true,
                keys: [id],
                items: [{
                  id,
                  kind: "execution" as const,
                  label: "Execution",
                  title: id,
                  startedAt: Date.now() - 14 * 60_000,
                }],
              },
            });
            f.update("tstv1-group-a", {
              title: "Explore implementation architecture endA",
              status: "busy",
              activity: running("explore-run"),
            });
            f.update("tstv1-group-b", { status: "busy" });
            f.add({
              ...base,
              id: "tstv1-trail-blocked",
              parentID: base.id,
              title: "Review integration boundaries endB",
              attention: { ...base.attention, questions: 1 },
            });
            f.update("tstv1-trail-blocked", {
              activity: {
                ...running("blocked-run"),
                inputs: { fresh: true, keys: ["trail-question"] },
              },
            });
            for (let n = 0; n < 60; n++) {
              const id = `tstv1-trail-cont-${n}`;
              f.add({
                ...base,
                id,
                parentID: base.id,
                title: n === 1
                  ? "Finished awaiting parent receipt"
                  : `communico backup-restore (cont. ${n})`,
              });
              if (n === 1) f.update(id, { activity: running("finished-run") });
              f.update(id, {
                activity: {
                  terminal: n === 1 ? Date.now() : 100,
                  outcome: "succeeded",
                  ...(n !== 1
                    ? {
                      delivered: {
                        parentID: base.id,
                        receipt: "parent-result",
                        terminal: 100,
                      },
                    }
                    : {}),
                },
              });
            }
            f.add({
              ...base,
              id: "tstv1-trail-nested",
              parentID: "tstv1-group-a",
              title: "Nested verification branch tail",
              status: "busy",
              activity: running("nested-run"),
            });
            f.update("tstv1-trail-nested", { activity: running("nested-run") });
            // Inspect delivery without viewing/acknowledging the helper. RPC
            // snapshots are lease-scoped just like the browser's replica.
            c.lease({
              directory: base.directory,
              selected: base.id,
              crumbs: ["tstv1-trail-cont-0"],
              rows: [],
            });
            return null;
          }
          if (
            profile === "contract-sessions-tab-groups" &&
            frame.params.target === "trail-overflow"
          ) {
            for (let n = 0; n < 21; n++) {
              f.add({
                ...base,
                id: `tstv1-trail-active-${n}`,
                parentID: base.id,
                title: `Working helper ${n}`,
                status: "busy",
                activity: {
                  work: {
                    fresh: true,
                    keys: [`active-${n}`],
                    items: [{
                      id: `active-${n}`,
                      kind: "execution",
                      label: "Execution",
                      title: `Working helper ${n}`,
                      startedAt: Date.now() - 14 * 60_000,
                    }],
                  },
                },
              });
            }
            return null;
          }
          if (
            profile === "contract-sessions-hierarchy" &&
            frame.params.target === "delivery-helpers" && action === "hold"
          ) {
            for (let n = 0; n < 4; n++) {
              f.add({
                ...base,
                id: `tstv1-delivery-helper-${n}`,
                parentID: n === 3 ? "tstv1-delivery-helper-2" : base.id,
                directory: n >= 2
                  ? join(root, "helper-checkout")
                  : base.directory,
                title: `Delivery helper ${n + 1}`,
              });
              f.update(`tstv1-delivery-helper-${n}`, {
                status: "busy",
                attention: { ...base.attention, questions: n < 3 ? 1 : 0 },
              });
            }
            await c.rpc("tasks.create", {
              directory: join(root, "helper-checkout"),
              name: "Split helper task",
              sessions: ["tstv1-delivery-helper-2"],
            });
            return null;
          }
          if (
            frame.params.target === "tabs-pin" && id &&
            profile === "contract-sessions-phantom"
          ) {
            const model = createTabs((session) =>
              c.rpc<TaskRecord>("tasks.create", {
                directory: session.directory,
                name: session.title,
                sessions: [session.id],
              })
            );
            try {
              const inbox =
                (await c.rpc<{ inbox: import("@otk/protocol").InboxSnapshot }>(
                  "inbox.get",
                  {},
                )).inbox;
              model.update({
                directory: base.directory,
                entries: f.entries,
                inbox,
              });
              return await model.pin(id);
            } finally {
              model.stop();
            }
          }
          if (profile === "contract-sessions-window" && action === "succeed") {
            rejectRename = false;
            return null;
          }
          if (
            profile === "contract-sessions-window" && action === "fail" && id
          ) {
            const revision = f.app.index.get(id)!.digest.revision + 1;
            f.app.index.applyDigest({
              id,
              revision,
              summary: {
                state: "ready",
                revision,
                total: knownDerived(
                  {
                    calls: 1,
                    cost: 2.5,
                    tokens: {
                      input: 10,
                      output: 2,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    },
                    contextPeak: 10,
                  },
                  "fixture",
                  revision,
                ),
              },
              turns: { upsert: {}, remove: [] },
              deleted: frame.params.target === "backgrounds"
                ? { at: 1700000000000, how: "provider" }
                : null,
            });
            return null;
          }
          if (remote && id === "tstv1-luch" && action === "hold") {
            remote.update(id, { status: "busy" });
            return null;
          }
          if (
            action === "release" && profile === "contract-sessions-membership"
          ) {
            gate.resolve();
            return null;
          }
          if (
            frame.params.target === "backgrounds" &&
            profile === "contract-sessions-axiom"
          ) {
            const other = f.entries[1];
            f.add({
              ...other,
              id: "tstv1-background-working",
              title: "Background working",
              status: "busy",
            });
            f.add({
              ...other,
              id: "tstv1-background-blocked",
              title: "Background needs you",
              attention: { ...other.attention, questions: 1 },
            });
            return null;
          }
          if (!id || !f.entries.some((e) => e.id === id)) {
            throw new Error("Foreign sessions identity");
          }
          const entry = f.entries.find((e) => e.id === id)!;
          if (action === "hold") {
            f.update(id, {
              status: "busy",
              attention: { ...entry.attention, questions: 0, permissions: 0 },
            });
          } else if (action === "freeze") {
            f.update(id, { attention: { ...entry.attention, questions: 1 } });
          } else if (action === "thaw") {
            f.update(id, { attention: { ...entry.attention, permissions: 1 } });
          } else if (action === "release") {
            f.update(id, {
              status: "idle",
              attention: { ...entry.attention, questions: 0, permissions: 0 },
            });
          } else throw new Error("Unsupported sessions scenario action");
          return null;
        }
        case "stop":
          gate.resolve();
          await c.close();
          await remote?.app.stop();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside sessions scenario");
      }
    },
  };
}
