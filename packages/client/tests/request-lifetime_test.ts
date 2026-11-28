// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { RequestLifetimes } from "../request-lifetime.ts";
import { createQuestionForm } from "../question-form.ts";
import { createForm } from "../forms.ts";
import { createState, type StateFactory } from "../state.ts";
import type {
  FormRequest,
  PermissionRequest,
  QuestionRequest,
} from "@otk/protocol";

Deno.test("notification and dock acquire the same scoped permission inventory", async () => {
  const owner = new RequestLifetimes();
  const entry = () => undefined;
  const budget = { replayops: 8, replaybytes: 8192 };
  let reads = 0;
  const load = () => {
    reads++;
    return Promise.resolve([permission]);
  };
  const scope = permission.sessionID;
  const background = owner.readPermissions(scope, entry, load, budget);
  const dock = owner.readPermissions(scope, entry, load, budget);
  assertEquals(await background, [permission]);
  assertEquals(await dock, [permission]);
  assertEquals(await owner.readPermissions(scope, entry, load, budget), [
    permission,
  ]);
  assertEquals(reads, 1);
  owner.resetPermissionScopes();
  assertEquals(await owner.readPermissions(scope, entry, load, budget), [
    permission,
  ]);
  assertEquals(reads, 2);
});
const question: QuestionRequest = {
  id: "q",
  sessionID: "child",
  questions: [{
    text: "Pick",
    options: [{ label: "A" }],
    custom: true,
    multiple: false,
  }],
};
const permission: PermissionRequest = {
  id: "p",
  sessionID: "child",
  kind: "read",
  title: "Read",
  patterns: [],
  alwaysPatterns: [],
  detail: { kind: "generic", summary: "Read" },
  time: 1,
};
const form: FormRequest = {
  id: "q",
  owner: { kind: "session", sessionID: "child" },
  directory: "/repo",
  title: "Pick",
  fields: [{
    key: "q0",
    type: "string",
    custom: true,
    options: [{ label: "A", value: "A" }],
  }],
  presentation: "question",
};
const entry = (id: string) => ({
  id,
  parentID: id === "child" ? "parent" : undefined,
});

Deno.test("retirement preserves canonical permission, question and form input until its captured release succeeds", () => {
  for (const kind of ["permission", "question", "form"] as const) {
    const owner = new RequestLifetimes();
    if (kind === "permission") {
      owner.receive({ op: "permission.upsert", request: permission });
      owner.draft(kind, permission.id, "Keep unsent feedback");
    } else if (kind === "question") {
      owner.receive({ op: "question.upsert", request: question });
      createQuestionForm(question, undefined, owner).typeOwn(
        0,
        "Keep unsent feedback",
      );
    } else {
      owner.receive({
        op: "form.upsert",
        request: { ...form, presentation: undefined },
      });
      createForm(form, undefined, owner).text("q0", "Keep unsent feedback");
    }
    const id = kind === "permission" ? permission.id : question.id;
    owner.retire(
      kind,
      id,
      "settled-remotely",
      "native retirement before tombstone",
    );
    owner.retireSessions((id) => id === "child");
    const captured = owner.retention("child", entry);
    assertEquals(captured.inputs.length, 1);
    assertEquals(
      captured.inputs[0].value.includes("Keep unsent feedback"),
      true,
    );
    assertEquals(owner.retention("unrelated", entry).inputs, []);
    assertEquals(owner.retention("parent", entry).inputs, captured.inputs);
    captured.discard();
    assertEquals(owner.retention("child", entry).inputs, []);
    const late = owner.settlement(kind, id);
    owner.draft(kind, id, "new draft");
    // Late local success cannot erase the input kept by remote retirement.
    late();
    assertEquals(owner.draft(kind, id), "new draft");
    const stale = owner.retention("child", entry);
    owner.draft(kind, id, "newer draft while navigation settles");
    stale.discard();
    assertEquals(owner.draft(kind, id), "newer draft while navigation settles");
    const local = new RequestLifetimes();
    local.receive({ op: "permission.upsert", request: permission });
    local.draft("permission", permission.id, "submitted");
    local.settlement("permission", permission.id)();
    local.draft(
      "permission",
      permission.id,
      "stale view write after confirmed submission",
    );
    assertEquals(local.retention("child", entry).inputs, []);
  }
});

Deno.test("draft retention waits for a deferred framework commit", () => {
  const pending: (() => void)[] = [];
  const factory: StateFactory = (initial) => {
    const store = createState(initial);
    return {
      ...store,
      update: (change) => {
        pending.push(() => store.update(change));
      },
    };
  };
  const owner = new RequestLifetimes();
  owner.receive({
    op: "form.upsert",
    request: { ...form, presentation: undefined },
  });
  createForm(form, factory, owner).text("q0", "committed text");
  for (const commit of pending) commit();
  assertEquals(
    createForm(form, undefined, owner).derive().answer.q0,
    "committed text",
  );
});

Deno.test("deleted request transfer keeps separate exact values and fences empty rows, late writes and settlement", () => {
  const owner = new RequestLifetimes();
  const lookup = (id: string) => ({
    parentID: ["child", "live"].includes(id) ? "parent" : undefined,
    deleted: ["parent", "child", "foreign"].includes(id),
  });
  const rows = [
    ["exact", "parent", "  same\nvalue\n"],
    ["descendant", "child", "  same\nvalue\n"],
    ["empty", "parent", ""],
    ["live", "live", "Leave the live helper alone"],
    ["foreign", "foreign", "Leave unrelated deletion alone"],
  ];
  for (const [id, sessionID, value] of rows) {
    owner.receive({
      op: "permission.upsert",
      request: { ...permission, id, sessionID },
    });
    owner.draft("permission", id, value);
  }
  owner.retireSessions((id) => lookup(id).deleted);
  const settle = owner.settlement("permission", "exact");
  owner.transferDeleted("parent", lookup, (values, release) => {
    assertEquals(values, [rows[0][2], rows[1][2]]);
    assertEquals(owner.draft("permission", "exact"), rows[0][2]);
    release();
  });
  settle();
  for (const id of ["exact", "descendant", "empty"]) {
    owner.draft("permission", id, "Stale view save");
    assertEquals(owner.draft("permission", id), undefined);
  }
  assertEquals(owner.get("permission", "exact")?.state, "retired");
  assertEquals(owner.draft("permission", "live"), rows[3][2]);
  assertEquals(owner.draft("permission", "foreign"), rows[4][2]);
  owner.transferDeleted("parent", lookup, (values, release) => {
    assertEquals(values, []);
    release();
  });
});

Deno.test("captured local settlement consumes submitted input across native delivery order without consuming newer input", () => {
  for (const kind of ["permission", "question", "form"] as const) {
    for (const nativeFirst of [false, true]) {
      const make = () => {
        const owner = new RequestLifetimes();
        if (kind === "permission") {
          owner.receive({ op: "permission.upsert", request: permission });
        } else if (kind === "question") {
          owner.receive({ op: "question.upsert", request: question });
        } else {owner.receive({
            op: "form.upsert",
            request: { ...form, presentation: undefined },
          });}
        return owner;
      };
      const id = kind === "permission" ? permission.id : question.id;
      const submitted = kind === "permission" ? "Submitted feedback" : {
        drafts: { q0: { text: "Submitted answer", touched: true } },
        review: true,
        step: 0,
      };
      const owner = make();
      owner.draft(kind, id, submitted);
      const confirmed = owner.settlement(kind, id);
      if (nativeFirst) {
        owner.retire(
          kind,
          id,
          "settled-remotely",
          "native delivery before RPC confirmation",
        );
      }
      confirmed();
      assertEquals(owner.draft(kind, id), undefined);
      owner.draft(kind, id, submitted); // Stale unmounted view writes are fenced.
      assertEquals(owner.retention("child", entry).inputs, []);
      const newerOwner = make();
      newerOwner.draft(kind, id, submitted);
      const late = newerOwner.settlement(kind, id);
      newerOwner.draft(kind, id, "Newer unsent input");
      if (nativeFirst) {
        newerOwner.retire(kind, id, "settled-remotely", "remote completion");
      }
      late();
      assertEquals(newerOwner.draft(kind, id), "Newer unsent input");
    }
  }
});

Deno.test("inventory replacement publishes one coherent request projection", () => {
  const owner = new RequestLifetimes();
  owner.receive({ op: "question.upsert", request: question });
  const observations: string[][] = [];
  owner.subscribe(() => observations.push(owner.questions().map((q) => q.id)));
  owner.replace("question", [{ ...question, id: "new" }], "parent", entry);
  assertEquals(observations, [["new"]]);
});

Deno.test("inventory scope witnesses bridge missing ancestry but never override a proven move", () => {
  const owner = new RequestLifetimes();
  const rows = new Map<string, { id: string; parentID?: string }>();
  const lookup = (id: string) => rows.get(id);
  owner.replace("question", [question], "parent", lookup);
  assertEquals(owner.questions("parent", lookup), [question]);
  rows.set("child", { id: "child", parentID: "other" });
  rows.set("other", { id: "other" });
  assertEquals(owner.questions("parent", lookup), []);
  assertEquals(owner.questions("other", lookup), [question]);
  owner.replace("question", [], "parent", lookup);
  assertEquals(owner.questions("other", lookup), [question]);
});

Deno.test("question and typed form are one lifetime through replacement and retirement", () => {
  const owner = new RequestLifetimes();
  owner.receive({ op: "form.upsert", request: form });
  assertEquals(owner.questions("parent", entry).length, 1);
  assertEquals(owner.get("question", "q"), owner.get("form", "q"));
  owner.receive({
    op: "form.upsert",
    request: {
      ...form,
      presentation: undefined,
      fields: [{ key: "ok", type: "boolean" }],
    },
  });
  owner.receive({ op: "question.remove", requestID: "q", sessionID: "child" });
  assertEquals(owner.questions(), []);
  assertEquals(owner.forms().length, 1);
  owner.replace("question", [question], "parent", entry);
  assertEquals(owner.questions(), []);
  owner.receive({ op: "form.remove", requestID: "q" });
  assertEquals(owner.questions(), []);
  assertEquals(owner.forms(), []);
  owner.receive({ op: "form.upsert", request: form });
  assertEquals(owner.forms(), []);
});
for (const kind of ["question", "form", "permission"] as const) {
  Deno.test(`local ${kind} dismissal keeps authority and dirty input independently of connectivity`, () => {
    const owner = new RequestLifetimes();
    owner.receive(
      kind === "question"
        ? { op: "question.upsert", request: question }
        : kind === "form"
        ? { op: "form.upsert", request: { ...form, presentation: undefined } }
        : { op: "permission.upsert", request: permission },
    );
    if (kind === "question") {
      createQuestionForm(question, undefined, owner).typeOwn(0, "dirty answer");
    } else if (kind === "form") {
      createForm(form, undefined, owner).text("q0", "dirty answer");
    } else owner.draft(kind, "p", "dirty reason");
    const id = kind === "permission" ? "p" : "q";
    owner.dismiss(kind, id);
    assertEquals(owner.get(kind, id)?.state, "pending");
    assertEquals(owner.dismissed("parent", entry).length, 1);
    assertEquals(
      owner.permissions("parent", entry, true).length +
        owner.questions("parent", entry, true).length +
        owner.forms("parent", entry, true).length,
      0,
    );
    owner.show(kind, id);
    if (kind === "question") {
      assertEquals(createQuestionForm(question, undefined, owner).answers(), [[
        "dirty answer",
      ]]);
    } else if (kind === "form") {
      assertEquals(
        createForm(form, undefined, owner).derive().answer.q0,
        "dirty answer",
      );
    } else assertEquals(owner.draft(kind, id), "dirty reason");
  });
}
Deno.test("retirement while a response is pending fences its late completion and stale inventory", async () => {
  const owner = new RequestLifetimes();
  owner.receive({ op: "question.upsert", request: question });
  const rpc = Promise.withResolvers<void>();
  const confirmed = owner.settlement("question", "q");
  const response = rpc.promise.then(confirmed);
  owner.receive({ op: "question.remove", requestID: "q", sessionID: "child" });
  rpc.resolve();
  await response;
  owner.replace("question", [question], "parent", entry);
  assertEquals(owner.questions(), []);
  assertEquals(owner.get("question", "q")?.state, "settled-remotely");
});
Deno.test("failed reconnect inventory cannot change a locally dismissed request or its draft", async () => {
  const owner = new RequestLifetimes();
  owner.receive({ op: "question.upsert", request: question });
  createQuestionForm(question, undefined, owner).typeOwn(0, "keep");
  owner.dismiss("question", "q");
  try {
    await Promise.reject(new Error("inventory unavailable"));
  } catch { /* Only successful inventory reaches replace. */ }
  assertEquals(owner.questions().length, 1);
  assertEquals(owner.questions(undefined, undefined, true), []);
  owner.show("question", "q");
  assertEquals(createQuestionForm(question, undefined, owner).answers(), [[
    "keep",
  ]]);
});
Deno.test("child deletion retires every parent projection even before a removal arrives", () => {
  const owner = new RequestLifetimes();
  owner.receive({ op: "question.upsert", request: question });
  owner.receive({ op: "permission.upsert", request: permission });
  assertEquals(owner.questions("parent", entry).length, 1);
  owner.retireSessions((id) => id === "child");
  assertEquals(owner.questions("parent", entry), []);
  assertEquals(owner.permissions("parent", entry), []);
  owner.receive({
    op: "question.upsert",
    request: { ...question, id: "late" },
  });
  assertEquals(owner.questions(), []);
});
Deno.test("live attention beats an older inventory before absence retirement", () => {
  const owner = new RequestLifetimes();
  owner.receive({ op: "question.upsert", request: question });
  owner.replace("question", [], "parent", entry, [{
    op: "question.upsert",
    request: question,
  }]);
  assertEquals(owner.questions("parent", entry), [question]);
});
