// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  OpencodeV2ServerAdapter,
  opencodeV2SessionID as ids,
} from "@otk/harness-opencode-v2-server";
import {
  type OperationContext,
  OperationFailure,
  type ReceiptData,
} from "@otk/protocol";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { nativeKind } from "../support/native.ts";
import { resources, withResources } from "../support/resources.ts";
import { waitFor } from "../support/opencode.ts";

function operation() {
  const receipts: ReceiptData[] = [], effects: number[] = [];
  const context: OperationContext = {
    signal: new AbortController().signal,
    key: {
      key: crypto.randomUUID(),
      clientID: crypto.randomUUID(),
      window: crypto.randomUUID(),
    },
    progress: () => {},
    beforeEffect: () => {
      effects.push(Date.now());
      return Promise.resolve();
    },
    checkpoint: (_kind, receipt) => {
      receipts.push(receipt);
      return Promise.resolve();
    },
    wait: (pending) => pending,
  };
  return { context, effects, receipts };
}
async function adapter(native: OpencodeV2Test) {
  const config = cfg(), events: string[] = [];
  const value = new OpencodeV2ServerAdapter({
    serviceFile: native.serviceFile,
    harness: config.harness,
    messages: config.messages,
    attachments: config.attachments,
  });
  resources().defer("V4 adapter", () => value.core.stop());
  await value.core.start({
    connection: () => {},
    indexReset: () => {},
    indexUpsert: () => {},
    indexRemove: (id) => events.push(id),
    content: () => {},
    bootstrapComplete: () => {},
    invalidate: () => {},
  });
  return { value, events };
}
async function complete(
  native: OpencodeV2Test,
  target: { id: string; nativeID: string },
) {
  await native.api.experimental.session.wait({ sessionID: target.nativeID });
  await waitFor(
    () => native.api.session.active(),
    (rows) => !rows[target.nativeID],
    30000,
  );
}
function test(name: string, fn: () => Promise<void>) {
  Deno.test({
    name,
    ignore: nativeKind !== "opencode-v2-server",
    fn: () => withResources(name, fn),
  });
}
test("OC2A1 rename/archive/delete and inclusive/empty/staged forks use authoritative native identities", async () => {
  const fake = new FakeLlm(),
    native = await OpencodeV2Test.start(fake),
    target = await native.createSession(),
    { value, events } = await adapter(native);
  const actions = value.capabilities.sessionActions!, op = operation();
  assertEquals(
    (await actions.rename(target.id, "Renamed V2 session", op.context)).title,
    "Renamed V2 session",
  );
  assertEquals(
    (await value.capabilities.sessionArchive!.archive(
      target.id,
      true,
      op.context,
    )).archived,
    true,
  );
  assertEquals(
    (await value.capabilities.sessionArchive!.archive(
      target.id,
      false,
      op.context,
    )).archived,
    false,
  );
  const empty = await actions.fork(target.id, undefined, op.context);
  assertEquals(empty.parentID, undefined);
  assertEquals(
    (await native.api.message.list({
      sessionID: ids.decode(empty.id),
      limit: 200,
    })).data,
    [],
  );
  for (const text of ["first", "second", "third"]) {
    fake.queue({ chunks: [text + " reply"] });
    await native.prompt(target.id, text);
    await complete(native, target);
  }
  const messages = (await native.api.message.list({
    sessionID: target.nativeID,
    limit: 200,
    order: "asc",
  })).data;
  const users = messages.filter((m) => m.type === "user");
  const through = await actions.fork(target.id, users[1].id, op.context);
  const copied = (await native.api.message.list({
    sessionID: ids.decode(through.id),
    limit: 200,
    order: "asc",
  })).data;
  assertEquals(copied.filter((m) => m.type === "user").map((m) => m.text), [
    "first",
    "second",
  ]);
  assertEquals(through.parentID, undefined);
  await value.capabilities.revert!.revert(target.id, users[1].id, op.context);
  const capped = await actions.fork(target.id, undefined, op.context);
  assertEquals(
    (await native.api.message.list({
      sessionID: ids.decode(capped.id),
      limit: 200,
    })).data.filter((m) => m.type === "user").map((m) => m.text),
    ["first"],
  );
  await value.capabilities.revert!.revert(
    target.id,
    messages[0].id,
    op.context,
  );
  const cappedEmpty = await actions.fork(target.id, undefined, op.context);
  assertEquals(
    (await native.api.message.list({
      sessionID: ids.decode(cappedEmpty.id),
      limit: 200,
    })).data,
    [],
  );
  await actions.remove(target.id, op.context);
  await waitFor(() => events, (rows) => rows.includes(target.id));
  assert(op.effects.length >= 10);
});

test("OC2A2 messages-only leaves files unchanged; code mode changes them; Restore recovers messages and settles its execution", async () => {
  const fake = new FakeLlm();
  const native = await OpencodeV2Test.start(fake, {
    config: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    prepare: async (fixture) => {
      await Deno.writeTextFile(fixture.directory + "/note.txt", "original\n");
      for (
        const args of [["add", "note.txt"], [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "fixture",
        ]]
      ) {
        const result = await new Deno.Command("git", {
          args,
          cwd: fixture.directory,
          stdout: "null",
          stderr: "piped",
        }).output();
        assert(result.success, new TextDecoder().decode(result.stderr));
      }
    },
  });
  const target = await native.createSession(),
    { value } = await adapter(native),
    op = operation();
  fake.queue({ tool: { name: "read", input: { path: "note.txt" } } });
  fake.queue({
    tool: {
      name: "edit",
      input: { path: "note.txt", oldString: "original", newString: "changed" },
    },
  });
  fake.queue({ chunks: ["edit complete"] });
  await native.prompt(target.id, "change note.txt");
  await complete(native, target);
  assertEquals(
    await Deno.readTextFile(native.directory + "/note.txt"),
    "changed\n",
  );
  const all = await native.api.message.list({
      sessionID: target.nativeID,
      limit: 200,
      order: "asc",
    }),
    user = all.data.find((m) => m.type === "user")!;
  const staged = await value.capabilities.revert!.revert(
    target.id,
    user.id,
    op.context,
  );
  assertEquals(
    await Deno.readTextFile(native.directory + "/note.txt"),
    "changed\n",
  );
  assertEquals(staged.revert?.messageCount, 1);
  assertEquals(staged.revert?.prompts?.[0].preview, "change note.txt");
  assertEquals(staged.revert?.files, []);
  const code = await value.capabilities.revertCode!.revert(
    target.id,
    user.id,
    op.context,
  );
  assertEquals(
    await Deno.readTextFile(native.directory + "/note.txt"),
    "original\n",
  );
  assert(code.revert?.files.some((f) => f.path === "note.txt"));
  // Re-stage at the SAME boundary in false mode; never clear between modes.
  await value.capabilities.revert!.revert(target.id, user.id, op.context);
  assertEquals(
    await Deno.readTextFile(native.directory + "/note.txt"),
    "changed\n",
  );
  const restored = await value.capabilities.restore!.restore(
    target.id,
    op.context,
  );
  assertEquals(restored.revert, undefined);
  assertEquals(
    await Deno.readTextFile(native.directory + "/note.txt"),
    "changed\n",
  );
  assertEquals((await native.api.session.active())[target.nativeID], undefined);
  const recovered = await value.core.listMessages(target.id, {});
  assert(recovered.items.some((m) => m.id === user.id));
  const before = op.effects.length;
  await value.capabilities.restore!.restore(target.id, op.context);
  assertEquals(
    op.effects.length,
    before,
    "Already-clear Restore must not wake native execution",
  );
});

test("OC2A3 attachment failure preserves stage; the next successful prompt makes history removal permanent; Busy is rejected", async () => {
  const fake = new FakeLlm(),
    native = await OpencodeV2Test.start(fake),
    target = await native.createSession(),
    { value } = await adapter(native);
  fake.queue({ chunks: ["old reply"] });
  await native.prompt(target.id, "old prompt");
  await complete(native, target);
  const rows = await native.api.message.list({
    sessionID: target.nativeID,
    limit: 200,
  });
  const user = rows.data.find((m) => m.type === "user")!;
  await value.capabilities.revert!.revert(target.id, user.id);
  await assertRejects(() =>
    native.api.session.prompt({
      sessionID: target.nativeID,
      text: "bad",
      files: [{ uri: "file:///does-not-exist-v4" }],
    })
  );
  assertEquals(
    (await value.core.getSession(target.id)).revert?.messageID,
    user.id,
  );
  fake.queue({ chunks: ["new ", "reply"], delay: 1000 });
  await native.prompt(target.id, "new prompt");
  await waitFor(
    () => native.api.session.active(),
    (rows) => !!rows[target.nativeID],
  );
  const error = await assertRejects(() =>
    value.capabilities.revert!.revert(target.id, user.id)
  );
  assert(error instanceof OperationFailure && error.outcome === "rejected");
  await complete(native, target);
  assertEquals((await value.core.getSession(target.id)).revert, undefined);
  const current = await native.api.message.list({
    sessionID: target.nativeID,
    limit: 200,
  });
  assert(!current.data.some((m) => m.id === user.id));
  await value.capabilities.restore!.restore(target.id);
  assert(
    !(await native.api.message.list({ sessionID: target.nativeID, limit: 200 }))
      .data.some((m) => m.id === user.id),
  );
});

test("OC2A4 shell stays non-LLM; commands prepare inputs before checkpointed selection; compaction settles", async () => {
  const fake = new FakeLlm(),
    native = await OpencodeV2Test.start(fake, {
      config: {
        commands: {
          fixture: {
            template: "command $ARGUMENTS",
            description: "V4 command",
          },
        },
      },
    });
  const target = await native.createSession(),
    { value } = await adapter(native),
    op = operation();
  await value.capabilities.shell!.shell({
    sessionID: target.id,
    command: "printf 'V4 shell output'",
  }, op.context);
  const rows = await native.api.message.list({
    sessionID: target.nativeID,
    limit: 200,
  });
  assert(rows.data.some((m) => m.type === "shell" && m.status === "exited"));
  assertEquals(rows.data.filter((m) => m.type === "assistant").length, 0);
  assert(
    (await value.capabilities.commands!.listCommands(target.id)).some((c) =>
      c.name === "fixture"
    ),
  );
  const before = op.effects.length;
  const preparation = await assertRejects(
    () =>
      value.capabilities.commands!.command({
        sessionID: target.id,
        command: "fixture",
        arguments: "args",
        agent: "plan",
        parts: [{ kind: "file", source: "path", path: "missing-v4" }],
      }, op.context),
    OperationFailure,
  );
  assertEquals(preparation.outcome, "rejected");
  assertEquals(preparation.code, "attachment");
  assertEquals(op.effects.length, before);
  fake.queue({ chunks: ["command completed"] });
  await value.capabilities.commands!.command({
    sessionID: target.id,
    command: "fixture",
    arguments: "args",
    model: { provider: "fake", model: "scripted" },
  }, op.context);
  assert(op.receipts.some((r) => r.kind === "session-selection"));
  fake.queue({ chunks: ["compact summary"] });
  await value.capabilities.sessionActions!.compact(target.id, {
    provider: "fake",
    model: "scripted",
  }, op.context);
  assertEquals((await native.api.session.active())[target.nativeID], undefined);
  assert(
    (await native.api.message.list({ sessionID: target.nativeID, limit: 200 }))
      .data.some((m) => m.type === "compaction"),
  );
});

test("OC2A5 skill invocation uses the native skill ID and preserves arguments and files across a staged revert", async () => {
  const fake = new FakeLlm(), config: Record<string, unknown> = {};
  const native = await OpencodeV2Test.start(fake, {
    config,
    prepare: async (fixture) => {
      const path = fixture.directory + "/skills/review-contract";
      await Deno.mkdir(path, { recursive: true });
      await Deno.writeTextFile(
        path + "/SKILL.md",
        "---\nname: review-contract\ndescription: Review a contract\n---\nRead the supplied contract carefully.\n",
      );
      config.skills = [fixture.directory + "/skills"];
    },
  });
  const target = await native.createSession(),
    { value } = await adapter(native),
    op = operation();
  fake.queue({ chunks: ["old reply"] });
  await native.prompt(target.id, "old prompt");
  await complete(native, target);
  const old =
    (await native.api.message.list({ sessionID: target.nativeID, limit: 200 }))
      .data.find((m) => m.type === "user")!;
  await value.capabilities.revert!.revert(target.id, old.id, op.context);
  fake.queue({ chunks: ["skill reply"] });
  await value.capabilities.commands!.command({
    sessionID: target.id,
    command: "review-contract",
    arguments: "Review these exact bytes",
    parts: [{
      kind: "file",
      source: "upload",
      name: "contract.txt",
      mime: "text/plain",
      dataBase64: btoa("contract bytes"),
    }],
  }, op.context);
  const rows = (await native.api.message.list({
    sessionID: target.nativeID,
    limit: 200,
    order: "asc",
  })).data;
  assert(!rows.some((m) => m.id === old.id));
  const user = rows.find((m) => m.type === "user");
  assert(user?.type === "user");
  assertEquals(user.text, "Review these exact bytes");
  assertEquals(user.files?.[0].name, "contract.txt");
  assertEquals(user.files?.[0].data, btoa("contract bytes"));
  // V2 stores prompt-selected skills on user.skills; the hidden activation is
  // removed with the staged suffix, rather than duplicating skill context.
  assertEquals(user.skills?.length, 1);
  assertEquals(user.skills?.[0].name, "review-contract");
  assertEquals(rows.filter((m) => m.type === "skill").length, 0);
  assert(op.receipts.some((r) => r.kind === "command-skill-activated"));
});
