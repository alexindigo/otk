// SPDX-License-Identifier: LGPL-3.0-only
// INV-T's stage/clear proof, restricted to the decision-independent round trip.
import { assert, assertEquals } from "@std/assert";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { nativeKind } from "../support/native.ts";
import { test } from "../support/resources.ts";

test("pending revert restores exact native messages, parts and changed files before sending", async () => {
  const fake = new FakeLlm(), v2 = nativeKind === "opencode-v2-server";
  const prepare = async (native: { directory: string }) => {
    await Deno.writeTextFile(native.directory + "/note.txt", "original\n");
    const result = await new Deno.Command("git", {
      args: ["add", "note.txt"],
      cwd: native.directory,
    }).output();
    assert(result.success);
  };
  const native = v2
    ? await OpencodeV2Test.start(fake, {
      prepare,
      config: {
        permissions: [{ action: "*", resource: "*", effect: "allow" }],
      },
    })
    : await OpencodeTest.start(fake, { "*": "allow" }, { prepare });
  const source = await native.createSession("Pending revert round trip");
  type NativeRow = {
    id?: string;
    type?: string;
    info?: { id: string; role: string; time: { completed?: number } };
  };
  const rows = async (): Promise<NativeRow[]> =>
    v2
      ? (await (native as OpencodeV2Test).api.message.list({
        sessionID: source.nativeID,
        limit: 200,
        order: "asc",
      })).data
      : await (native as OpencodeTest).request(`/session/${source.id}/message`);
  const settled = async () => {
    if (v2) {
      const v = native as OpencodeV2Test;
      await v.api.experimental.session.wait({ sessionID: source.nativeID });
      await waitFor(
        () => v.api.session.active(),
        (state) => !state[source.nativeID],
      );
    } else {
      await waitFor(rows, (messages) => {
        const last = messages.at(-1)?.info;
        return last?.role === "assistant" && last.time.completed !== undefined;
      });
    }
  };
  fake.queue({
    tool: {
      name: "read",
      input: v2
        ? { path: "note.txt" }
        : { filePath: native.directory + "/note.txt" },
    },
  });
  fake.queue({
    tool: {
      name: "edit",
      input: {
        [v2 ? "path" : "filePath"]: v2
          ? "note.txt"
          : native.directory + "/note.txt",
        oldString: "original",
        newString: "changed",
      },
    },
  });
  fake.queue({ chunks: ["Original branch reply"] });
  await native.prompt(source.id, "Change note.txt");
  await settled();
  const before = await rows();
  const prompt = before.find((row) =>
    (v2 ? row.type : row.info?.role) === "user"
  )!;
  const boundary = (v2 ? prompt.id : prompt.info?.id)!;
  assertEquals(
    await Deno.readTextFile(native.directory + "/note.txt"),
    "changed\n",
  );
  if (v2) {
    await native.stageRevert(source.id, boundary, false);
    assertEquals(await rows(), before);
    assertEquals(
      await Deno.readTextFile(native.directory + "/note.txt"),
      "changed\n",
    );
  }
  await native.stageRevert(source.id, boundary, true);
  assertEquals(
    await rows(),
    before,
    "staging retains all native rows and parts",
  );
  assertEquals(
    await Deno.readTextFile(native.directory + "/note.txt"),
    "original\n",
  );
  await native.restore(source.id);
  await settled();
  const after = await rows();
  // V2 additionally records the idle caused by clear; the original rows are exact.
  assertEquals(v2 ? after.slice(0, before.length) : after, before);
  const restored = await native.readSession(source.id) as { revert?: unknown };
  assertEquals(restored.revert, undefined);
  assertEquals(
    await Deno.readTextFile(native.directory + "/note.txt"),
    "changed\n",
  );
});
