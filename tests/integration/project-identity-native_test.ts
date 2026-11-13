// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { FakeLlm } from "../support/fake-llm.ts";
import { test } from "../support/resources.ts";
import { nativeKind, nativeVersion } from "../support/native.ts";
import { OpencodeTest } from "../support/opencode.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { inboxProjects, projectHierarchy } from "@otk/client";
import type { ProjectSeed } from "@otk/harness";
import { ProjectSummaries } from "../../core/index/project-summaries.ts";
import { DigestBridge } from "../../core/digest/bridge.ts";
import { cfg } from "../support/config.ts";

async function seeds(
  oc: OpencodeTest | OpencodeV2Test,
  stage: string,
): Promise<ProjectSeed[]> {
  const settings = cfg();
  const bridge = new DigestBridge({
    statePath: oc.root + "/identity-" + stage,
    provider: nativeKind,
    native: oc instanceof OpencodeV2Test
      ? {
        serviceFile: oc.serviceFile,
        db: oc.db,
        requestms: settings.harness.requestms,
        attachments: settings.attachments,
      }
      : {
        harness: { ...settings.harness, db: oc.db, url: oc.url },
        index: settings.index,
        attachments: settings.attachments,
      },
    policy: settings.digest,
    publish() {},
  });
  try {
    return (await bridge.projects(1, new AbortController().signal)).projects;
  } finally {
    await bridge.stop();
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    cwd,
    args,
    stdout: "piped",
    stderr: "piped",
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout);
}

async function seed(oc: { directory: string }) {
  await Deno.writeTextFile(oc.directory + "/seed", "fixture\n");
  await git(oc.directory, "add", "seed");
  await git(
    oc.directory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "Fixture root",
  );
  await git(
    oc.directory,
    "worktree",
    "add",
    "-b",
    "topic",
    oc.directory + ".tree",
  );
  await Deno.mkdir(oc.directory + ".tree/src");
}

function projection(seeds: ProjectSeed[]) {
  const owner = new ProjectSummaries(() => ({ seen: 0, finish: 0 }), () => {});
  owner.seed(seeds);
  const summaries = Object.fromEntries(owner.values);
  return projectHierarchy(inboxProjects([], {
    projects: [],
    tasks: [],
    seen: {},
    finishes: {},
    pathTemplates: [],
    summaries,
  }, Date.now())).map((r) => ({
    directory: r.directory,
    depth: r.depth ?? 0,
    group: r.group,
    topology: r.topology,
    availability: summaries[r.directory]?.availability,
    scopes: summaries[r.directory]?.scopes,
    sessionCount: summaries[r.directory]?.sessionCount,
  }));
}

test(`native ${nativeVersion}: removed worktree keeps durable identity and exact population`, async () => {
  const fake = new FakeLlm();
  const stages: unknown[] = [];
  const evidence = ".test-state/project-identity";
  await Deno.mkdir(evidence, { recursive: true });
  if (nativeKind === "opencode-v2-server") {
    const oc = await OpencodeV2Test.start(fake, { prepare: seed });
    const main = await oc.api.session.create({
      location: { directory: oc.directory },
      title: "Main",
    });
    const tree = oc.directory + ".tree";
    const child = await oc.api.session.create({
      location: { directory: tree + "/src" },
      title: "Tree",
    });
    assertEquals(main.projectID, child.projectID);
    const db = new DatabaseSync(oc.db, { readOnly: true });
    try {
      const snap = async (stage: string) => {
        const reported = await oc.api.project.list({ archived: true });
        const rows = db.prepare(
          "SELECT id,project_id,workspace_id,directory,path FROM session_v2 ORDER BY id",
        ).all();
        const view = projection(await seeds(oc, stage));
        stages.push({
          stage,
          reported,
          worktrees: db.prepare("SELECT * FROM worktree").all(),
          projectDirectory: db.prepare("SELECT * FROM project_directory")
            .all(),
          rows,
          view,
        });
        return view;
      };
      const before = await snap("before");
      assertEquals(before.find((r) => r.directory === tree)?.depth, 1);
      const nativeTree = oc.directory + ".native-tree";
      await git(
        oc.directory,
        "worktree",
        "add",
        "--detach",
        nativeTree,
        "HEAD",
      );
      await Deno.mkdir(nativeTree + "/src");
      const nativeChild = await oc.api.session.create({
        location: { directory: nativeTree + "/src" },
        title: "Native removed tree",
      });
      assertEquals(nativeChild.projectID, main.projectID);
      await oc.api.worktree.remove({
        projectID: main.projectID,
        directory: nativeTree,
        force: false,
      });
      const nativeRemoved = await snap("native-removed");
      assertEquals(
        nativeRemoved.find((r) => r.directory === nativeTree)?.depth,
        1,
      );
      assertEquals(
        nativeRemoved.find((r) => r.directory === nativeTree)?.availability,
        "removed",
      );
      assertEquals(
        nativeRemoved.find((r) => r.directory === nativeTree)?.sessionCount,
        1,
      );
      await git(oc.directory, "worktree", "remove", tree);
      await git(oc.directory, "branch", "-d", "topic");
      const unrefreshed = await snap("removed-before-refresh");
      assertEquals(unrefreshed.find((r) => r.directory === tree)?.depth, 1);
      await oc.api.worktree.refresh({ projectID: main.projectID });
      const after = await snap("removed-after-refresh");
      assertEquals(
        db.prepare("SELECT project_id FROM session_v2 WHERE id=?").get(child.id)
          ?.project_id,
        main.projectID,
      );
      assertEquals(
        (await oc.api.session.get({ sessionID: child.id })).projectID,
        main.projectID,
      );
      assertEquals(after.find((r) => r.directory === tree)?.depth, 1);
      assertEquals(
        after.find((r) => r.directory === tree)?.availability,
        "removed",
      );
      assertEquals(after.find((r) => r.directory === tree)?.scopes, [
        tree,
        tree + "/src",
      ]);
      assertEquals(after.find((r) => r.directory === tree)?.sessionCount, 1);
      assertEquals(
        after.find((r) => r.directory === oc.directory)?.sessionCount,
        3,
      );
      await oc.restart();
      assertEquals(
        (await snap("cold-restart")).find((r) => r.directory === tree)?.depth,
        1,
      );
      const moved = oc.directory + ".moved";
      await Deno.rename(oc.directory, moved);
      const newSession = await oc.api.session.create({
        location: { directory: moved },
        title: "Moved main",
      });
      assertEquals(newSession.projectID, main.projectID);
      const renamed = await snap("main-renamed");
      assertEquals(renamed.find((r) => r.directory === oc.directory)?.depth, 1);
      await oc.api.worktree.refresh({ projectID: main.projectID });
      const renamedRefreshed = await snap("main-renamed-after-refresh");
      assertEquals(
        renamedRefreshed.find((r) => r.directory === oc.directory)?.depth,
        1,
      );
      await Deno.remove(moved, { recursive: true });
      const deleted = await snap("all-directories-deleted");
      assertEquals(
        deleted.find((r) => r.directory === tree)?.topology?.canonicalRoot,
        moved,
      );
      assertEquals(deleted.find((r) => r.directory === moved)?.sessionCount, 4);
      assertEquals(
        db.prepare("SELECT COUNT(*) AS count FROM session_v2 WHERE id=?").get(
          child.id,
        )?.count,
        1,
      );
    } finally {
      db.close();
      await Deno.writeTextFile(
        `${evidence}/native-${nativeVersion}.json`,
        JSON.stringify(stages, null, 2),
      );
    }
  } else {
    const oc = await OpencodeTest.start(fake, { bash: "ask" }, {
      prepare: seed,
    });
    const main = await oc.session<{ id: string; projectID: string }>(
      "/session",
      { method: "POST", body: { title: "Main" } },
    );
    const tree = oc.directory + ".tree";
    const child = await oc.session<{ id: string; projectID: string }>(
      "/session",
      { method: "POST", directory: tree + "/src", body: { title: "Tree" } },
    );
    assertEquals(main.projectID, child.projectID);
    const db = new DatabaseSync(oc.db, { readOnly: true });
    try {
      const snap = async (stage: string) => {
        const response = await fetch(oc.url + "/project");
        assert(response.ok);
        const reported = await response.json();
        const view = projection(await seeds(oc, stage));
        stages.push({
          stage,
          reported,
          projectDirectory: db.prepare("SELECT * FROM project_directory").all(),
          rows: db.prepare(
            "SELECT id,project_id,workspace_id,directory FROM session",
          ).all(),
          view,
        });
        return view;
      };
      assertEquals(
        (await snap("before")).find((r) => r.directory === tree)?.depth,
        1,
      );
      await git(oc.directory, "worktree", "remove", "--force", tree);
      await git(oc.directory, "branch", "-d", "topic");
      await snap("removed-before-instance-refresh");
      await oc.restart();
      await oc.session("/session", {
        method: "POST",
        body: { title: "Reopen main" },
      });
      const after = await snap("removed-after-instance-refresh");
      assertEquals(
        db.prepare("SELECT project_id FROM session WHERE id=?").get(
          child.nativeID,
        )?.project_id,
        main.projectID,
      );
      assertEquals(after.find((r) => r.directory === tree)?.depth, 1);
      assertEquals(
        after.find((r) => r.directory === tree)?.availability,
        "removed",
      );
      assertEquals(after.find((r) => r.directory === tree)?.sessionCount, 1);
      assertEquals(
        after.find((r) => r.directory === oc.directory)?.sessionCount,
        3,
      );
    } finally {
      db.close();
      await Deno.writeTextFile(
        `${evidence}/native-${nativeVersion}.json`,
        JSON.stringify(stages, null, 2),
      );
    }
  }
});
