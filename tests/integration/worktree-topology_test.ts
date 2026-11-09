// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";
import { test } from "../support/resources.ts";
import type { InboxBaseline } from "@otk/protocol";

test("V1 native worktrees share repo identity and publish separate leaf populations through the worker and inbox", async () => {
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake, {}, {
    async prepare(native) {
      const commands = [
        [
          "-C",
          native.directory,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@invalid",
          "commit",
          "--allow-empty",
          "-m",
          "Worktree fixture",
        ],
        [
          "-C",
          native.directory,
          "worktree",
          "add",
          "-b",
          "feature",
          join(native.root, "feature"),
        ],
        [
          "-C",
          native.directory,
          "worktree",
          "add",
          "-b",
          "quiet",
          join(native.root, "quiet"),
        ],
      ];
      for (const args of commands) {
        const result = await new Deno.Command("git", {
          args,
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert(result.success, new TextDecoder().decode(result.stderr));
      }
    },
  });
  const directories = [
    oc.directory,
    join(oc.root, "feature"),
    join(oc.root, "quiet"),
    join(oc.root, "feature", "src"),
  ];
  await Deno.mkdir(directories[3], { recursive: true });
  const sessions = [];
  for (const directory of directories) {
    sessions.push(
      await oc.session<{ id: string; projectID: string; directory: string }>(
        "/session",
        { method: "POST", directory, body: { title: "Worktree topology" } },
      ),
    );
  }
  assertEquals(new Set(sessions.map((s) => s.projectID)).size, 1);
  assert(sessions[0].projectID !== "global");
  const sidecar = await SidecarTest.start(oc);
  const client = new WsClient(sidecar.url);
  try {
    await client.connect();
    const summaries = () =>
      client.rpc<InboxBaseline>("inbox.get", {}).then((b) => b.inbox.summaries);
    await waitFor(
      summaries,
      (values) => values?.[oc.directory]?.sessionCount === 4,
    );
    const values = (await summaries())!;
    for (const directory of directories.slice(1, 3)) {
      assertEquals(
        values[directory].sessionCount,
        directory === directories[1] ? 2 : 1,
      );
      assertEquals(values[directory].topology, {
        repoID: sessions[0].projectID,
        canonicalRoot: oc.directory,
        leafDirectory: directory,
        parentDirectory: oc.directory,
      });
    }
    assertEquals(values[directories[1]].scopes, [
      directories[1],
      directories[3],
    ]);
    assertEquals(values[directories[3]], undefined);
    assertEquals(values[oc.directory].direct?.sessionCount, 1);
    await client.rpc("projects.inactive", {
      directory: directories[1],
      inactive: true,
    });
    assertEquals(
      (await client.rpc<InboxBaseline>("inbox.get", {})).inbox.projects.find((
        p,
      ) => p.directory === directories[1])?.inactive,
      true,
    );
    const retained = await oc.request<
      { id: string; time: { archived?: number } }
    >(`/session/${sessions[1].id}`, { directory: directories[1] });
    assertEquals(retained.id, sessions[1].nativeID);
    assertEquals(retained.time.archived, undefined);
    for (const i of [1, 3]) {
      await oc.request(`/session/${sessions[i].id}`, {
        method: "DELETE",
        directory: directories[i],
      });
    }
    await waitFor(
      summaries,
      (next) =>
        next?.[directories[1]]?.sessionCount === 0 &&
        next?.[oc.directory]?.sessionCount === 2,
    );
    const empty = (await summaries())![directories[1]];
    assertEquals(empty.topology, values[directories[1]].topology);
    assertEquals(
      (await client.rpc<InboxBaseline>("inbox.get", {})).inbox.projects.find((
        p,
      ) => p.directory === directories[1])?.inactive,
      true,
    );
  } finally {
    await client.close();
  }
});
