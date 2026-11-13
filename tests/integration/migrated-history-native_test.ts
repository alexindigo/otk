// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  mapMessage,
  Messages,
  type NativeMessage,
  TranscriptReads,
} from "@otk/harness-opencode-v2-server";
import { DatabaseSync } from "node:sqlite";
import { TurnTimingAccumulator } from "@otk/harness";
import { nativeKind } from "../support/native.ts";

Deno.test({
  name:
    "stock V1 initializes history and V2 migrates tools without losing targets",
  ignore: nativeKind !== "opencode-v2-server",
  fn: async () => {
    const result = await new Deno.Command("python3", {
      args: ["tests/support/migrated-history.py"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(result.success, new TextDecoder().decode(result.stderr));
    const receipt = JSON.parse(
      new TextDecoder().decode(result.stdout).trim().split("\n").at(-1)!,
    );
    const fixture = JSON.parse(await Deno.readTextFile(receipt.fixture));
    await Deno.mkdir(".test-state/do", { recursive: true });
    await Deno.writeTextFile(
      ".test-state/do/migrated-history-native.json",
      JSON.stringify({ receipt, fixture }, null, 2),
    );
    assertEquals(
      fixture.provenance.route,
      "stock V1 initializes SQLite; stopped private fixture seed; stock V2 migration; native V2 HTTP response",
    );
    const calls = (fixture.v2 as NativeMessage[]).flatMap((raw, order) =>
      mapMessage(raw, "opcv2-" + receipt.session, { order })?.parts ?? []
    ).flatMap((p) => p.kind === "tool" ? [p.call] : []);
    const patch = calls.find((c) => c.sourceName === "apply_patch");
    assert(patch?.tool === "patch");
    assertEquals(patch.files[0].path, "/fixture/alpha.ts");
    const read = calls.find((c) => c.tool === "read" && c.status === "error");
    assert(read?.tool === "read");
    assertEquals([read.path, read.offset, read.limit], [
      "/fixture/beta.ts",
      190,
      50,
    ]);
    const task = calls.find((c) => c.tool === "task");
    assert(task?.tool === "task");
    assertEquals([task.agent, task.childSessionID], [
      "junior",
      "opcv2-ses_child",
    ]);
    const shell = calls.find((c) => c.tool === "bash");
    assert(shell?.tool === "bash");
    assertEquals(shell.cwd, "/fixture");
    const database = new DatabaseSync(
      receipt.fixture.replace(/fixture\.json$/, "data/opencode/opencode.db"),
      { readOnly: true },
    );
    try {
      const reads = new TranscriptReads(
        new Messages(() => {
          throw new Error("No native HTTP after shutdown");
        }),
        () => database,
      );
      const rows = reads.sqlHeaders(
        "opcv2-" + receipt.session,
        undefined,
        200,
      )!;
      const timing = new TurnTimingAccumulator();
      for (const row of rows) if (row.timing) timing.add(row.timing);
      const result = timing.result();
      assert(result?.state === "unknown");
      assertEquals(result.reason, "migration");
      assertEquals(result.terminal, true);
      assertEquals(result.end, undefined);
      assertEquals(result.start, fixture.firstCreated);
    } finally {
      database.close();
    }
  },
});
