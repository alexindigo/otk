// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  OpencodeV2ServerAdapter,
  opencodeV2SessionID as ids,
} from "@otk/harness-opencode-v2-server";
import type { FormAnswer, SessionMetadata } from "@otk/protocol";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { nativeKind } from "../support/native.ts";
import { resources, withResources } from "../support/resources.ts";
import { waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test({
  name:
    "OC2A1 all native form fields retain typed answers, asking owner and global location across reconnect",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 typed forms", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm()),
        target = await native.createSession(),
        settings = cfg();
      const adapter = new OpencodeV2ServerAdapter({
        serviceFile: native.serviceFile,
        harness: settings.harness,
        messages: settings.messages,
      });
      resources().defer("actions adapter", () => adapter.core.stop());
      const entries = new Map<string, SessionMetadata>();
      let boots = 0;
      await adapter.core.start({
        connection() {},
        indexReset() {},
        indexRemove() {},
        indexUpsert: (entry) => {
          entries.set(entry.id, entry);
        },
        content() {},
        invalidate() {},
        bootstrapComplete() {
          boots++;
        },
      });
      const form = await native.api.session.form.create({
        sessionID: target.nativeID,
        title: "Configure deployment",
        fields: [
          {
            key: "name",
            type: "string",
            required: true,
            minLength: 2,
            pattern: "^[a-z]+$",
          },
          {
            key: "mode",
            type: "string",
            options: [{ value: "now", label: "Deploy now" }],
            default: "now",
          },
          {
            key: "rate",
            type: "number",
            required: true,
            minimum: 0,
            maximum: 1,
          },
          { key: "count", type: "integer", required: true, minimum: 1 },
          { key: "enabled", type: "boolean", required: true },
          {
            key: "regions",
            type: "multiselect",
            custom: true,
            options: [{ value: "west", label: "West region" }],
            minItems: 1,
          },
          {
            key: "hidden",
            type: "string",
            hidden: true,
            default: "supplied",
            required: true,
          },
          {
            key: "conditional",
            type: "string",
            when: [{ key: "enabled", op: "eq", value: true }],
          },
          {
            key: "external",
            type: "external",
            url: "https://example.com/confirm",
          },
        ],
      });
      const forms = adapter.capabilities.forms!;
      await waitFor(
        () => forms.list({ sessionID: target.id }),
        (rows) => rows.length === 1,
      );
      assertEquals(entries.get(target.id)?.attention.questions, 1);
      await assertRejects(() => forms.reply(form.id, { name: "fixture" }));
      assertEquals((await forms.list())[0].id, form.id);
      const answer: FormAnswer = {
        name: "fixture",
        mode: "now",
        rate: .25,
        count: 2,
        enabled: false,
        regions: ["west", "custom"],
        hidden: "supplied",
        external: true,
      };
      await forms.reply(form.id, answer);
      const settled = await native.api.session.form.get({
        sessionID: target.nativeID,
        formID: form.id,
      });
      assertEquals(settled.state, { status: "answered", answer });
      await waitFor(
        () => entries.get(target.id)?.attention.questions,
        (count) => count === 0,
      );
      const options = {
        headers: {
          "x-opencode-directory": encodeURIComponent(native.directory),
        },
      };
      const global = await native.nativeApi.session.form.create({
        sessionID: "global",
        title: "External authentication",
        fields: [{
          key: "done",
          type: "external",
          url: "https://example.com/verify",
        }],
      }, options);
      const before = boots;
      native.proxy.disconnect();
      await waitFor(() => boots, (n) => n > before);
      const globals = await waitFor(
        () => forms.list(),
        (rows) => rows.some((f) => f.id === global.id),
      );
      assertEquals(globals.find((f) => f.id === global.id)?.owner, {
        kind: "location",
        directory: native.directory,
      });
      assert(!entries.has(ids.encode("global")));
      await forms.reply(global.id, { done: true });
      assertEquals(
        (await native.nativeApi.session.form.get({
          sessionID: "global",
          formID: global.id,
        }, options)).state,
        { status: "answered", answer: { done: true } },
      );
      const declined = await native.api.session.form.create({
        sessionID: target.nativeID,
        title: "Decline",
        fields: [{ type: "string", key: "answer" }],
      });
      await waitFor(
        () => forms.list(),
        (rows) => rows.some((f) => f.id === declined.id),
      );
      await forms.cancel(declined.id, "Choose another approach.");
      assertEquals(
        (await native.api.session.form.get({
          sessionID: target.nativeID,
          formID: declined.id,
        })).state,
        { status: "cancelled", message: "Choose another approach." },
      );
    }),
});

Deno.test({
  name:
    "OC2A2 server-owned auto approval replies once to late helper without viewers, off restores manual asking identity",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 unattended permissions", async () => {
      const native = await OpencodeV2Test.start(new FakeLlm()),
        root = await native.createSession();
      const app = await SidecarTest.start(native), ws = new WsClient(app.url);
      const nativeRules =
        (await native.nativeApi.session.get({ sessionID: root.nativeID }))
          .permissions;
      await ws.connect();
      await ws.rpc("permission.auto", { sessionID: root.id, enabled: true });
      await ws.close();
      const middle = await native.nativeApi.session.create({
        parentID: root.nativeID,
        title: "Unseen intermediate helper",
      });
      const child = await native.nativeApi.session.create({
        parentID: middle.id,
        title: "Late helper",
      });
      let result: unknown;
      const asking = native.nativeApi.permission.create({
        sessionID: child.id,
        action: "shell",
        resources: ["echo automatic"],
      }).then((v) => {
        result = v;
      });
      await waitFor(() => result, (value) => value !== undefined, 30_000);
      await asking;
      await waitFor(
        () => native.nativeApi.permission.list({ sessionID: child.id }),
        (rows) => rows.length === 0,
        30_000,
      );
      assertEquals(
        (await native.nativeApi.permission.list({ sessionID: child.id }))
          .length,
        0,
      );
      const user = new WsClient(app.url);
      await user.connect();
      const activity = await waitFor(() =>
        user.rpc<import("@otk/protocol").PermissionActivityPage>(
          "permission.activity",
          { sessionID: root.id },
        ), (page) =>
        page.entries.some((entry) => entry.outcome === "confirmed"));
      assertEquals(
        activity.entries.filter((entry) =>
          entry.outcome === "confirmed"
        ).map(
          (entry) => [entry.source, entry.reply, entry.request.sessionID],
        ),
        [["auto", "once", ids.encode(child.id)]],
      );
      assertEquals(
        (await native.nativeApi.session.get({ sessionID: root.nativeID }))
          .permissions,
        nativeRules,
      );
      await user.rpc("permission.auto", { sessionID: root.id, enabled: false });
      const ask = native.nativeApi.permission.create({
        sessionID: child.id,
        action: "shell",
        resources: ["echo manual"],
      });
      const outcome = ask.then((value) => ({ value }), (error) => ({ error }));
      const rows = await waitFor(() =>
        user.rpc<import("@otk/protocol").PermissionRequest[]>(
          "permission.list",
          { sessionID: root.id },
        ), (rows) =>
        rows.length === 1);
      assertEquals(rows[0].sessionID, ids.encode(child.id));
      await user.rpc("permission.reply", {
        sessionID: rows[0].sessionID,
        requestID: rows[0].id,
        reply: "once",
      });
      assertEquals("value" in await outcome, true);
      await waitFor(() =>
        native.nativeApi.permission.list({ sessionID: child.id }), (requests) =>
        requests.length === 0);
      await user.close();
    }),
});

Deno.test({
  name:
    "OC2A3 prepared prompt preserves admitted text/upload/path bytes, changed selections and idle/busy interrupt",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 prompt and interrupt", async () => {
      const fake = new FakeLlm(),
        native = await OpencodeV2Test.start(fake),
        target = await native.createSession(),
        settings = cfg();
      const adapter = new OpencodeV2ServerAdapter({
        serviceFile: native.serviceFile,
        harness: settings.harness,
        messages: settings.messages,
        attachments: settings.attachments,
      });
      resources().defer("prompt adapter", () => adapter.core.stop());
      const entries = new Map<string, SessionMetadata>();
      await adapter.core.start({
        connection() {},
        indexReset() {},
        indexRemove() {},
        indexUpsert: (entry) => {
          entries.set(entry.id, entry);
        },
        content() {},
        invalidate() {},
        bootstrapComplete() {},
      });
      const prompt = adapter.capabilities.prompt!;
      const before = await native.api.session.get({
        sessionID: target.nativeID,
      });
      await assertRejects(() =>
        prompt.prompt({
          sessionID: target.id,
          mode: "normal",
          agent: "plan",
          parts: [{ kind: "file", source: "path", path: "missing.txt" }],
        })
      );
      assertEquals(
        (await native.api.session.get({ sessionID: target.nativeID })).agent,
        before.agent,
      );
      await Deno.writeTextFile(
        native.directory + "/selected.txt",
        "first\nselected line\nlast\n",
      );
      fake.queue({ chunks: ["Prompt received."] });
      await prompt.prompt({
        sessionID: target.id,
        mode: "normal",
        agent: "plan",
        model: { provider: "fake", model: "scripted" },
        parts: [
          { kind: "text", text: "  Keep this exact prompt\n" },
          {
            kind: "file",
            source: "upload",
            name: "recalled.txt",
            mime: "text/plain",
            dataBase64: "cmVjYWxsZWQgYnl0ZXM=",
          },
          {
            kind: "file",
            source: "path",
            path: "selected.txt",
            range: { start: 2, end: 2 },
          },
        ],
      });
      const messages = await waitFor(
        () =>
          native.api.message.list({
            sessionID: target.nativeID,
            limit: 10,
            order: "desc",
          }),
        (rows) => JSON.stringify(rows).includes("Prompt received."),
        30_000,
      );
      const user = messages.data.find((message) => message.type === "user");
      assert(user?.type === "user");
      assertEquals(user.text, "  Keep this exact prompt\n");
      assertEquals(
        user.files?.map((file) => "data" in file ? atob(file.data) : "stored"),
        ["recalled bytes", "selected line"],
      );
      assertEquals(
        (await native.api.session.get({ sessionID: target.nativeID })).agent,
        "plan",
      );
      await waitFor(
        () => native.api.session.active(),
        (active) => !active[target.nativeID],
      );
      await prompt.abort(target.id); // interrupted:false is idle success.
      fake.queue({
        chunks: Array.from({ length: 30 }, () => "still running"),
        delay: 250,
      });
      await prompt.prompt({
        sessionID: target.id,
        mode: "normal",
        parts: [{ kind: "text", text: "Run until interrupted" }],
      });
      await waitFor(
        () => entries.get(target.id)?.status,
        (status) => status === "busy",
      );
      await prompt.abort(target.id);
      await waitFor(
        () => native.api.session.active(),
        (active) => !active[target.nativeID],
      );
      await waitFor(
        () => entries.get(target.id)?.status,
        (status) => status === "idle",
      );
    }),
});
