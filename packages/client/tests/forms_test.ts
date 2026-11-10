// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { FormRequest } from "@otk/protocol";
import { createForm, deriveForm, forgetForm } from "../forms.ts";
const request: FormRequest = {
  id: "typed-all",
  owner: { kind: "location", directory: "/repo" },
  directory: "/repo",
  title: "Configure deployment",
  fields: [
    {
      key: "mode",
      type: "string",
      options: [{ value: "deploy", label: "Deploy now" }, {
        value: "later",
        label: "Later",
      }],
      default: "deploy",
    },
    { key: "rate", type: "number", required: true, minimum: 0 },
    { key: "count", type: "integer", required: true, minimum: 1, maximum: 10 },
    { key: "enabled", type: "boolean", required: true },
    {
      key: "tags",
      type: "multiselect",
      options: [{ value: "alpha", label: "Alpha label" }],
      custom: true,
      minItems: 1,
    },
    {
      key: "secret",
      type: "string",
      hidden: true,
      required: true,
      default: "supplied",
      when: [{ key: "mode", op: "eq", value: "deploy" }],
    },
    {
      key: "dependent",
      type: "string",
      default: "visible",
      when: [{ key: "secret", op: "neq", value: "other" }],
    },
    { key: "web", type: "external", url: "https://example.com/verify" },
  ],
};
Deno.test("single-choice forms retain custom text independently of the selected offered value", () => {
  const input: FormRequest = {
    ...request,
    id: "retained-single-custom",
    fields: [{
      key: "mode",
      type: "string",
      custom: true,
      options: [{ value: "offered", label: "Offered choice" }],
    }],
  };
  const form = createForm(input);
  form.text("mode", "my custom value");
  form.pick("mode", "offered");
  const remounted = createForm(input);
  assertEquals(remounted.derive().answer.mode, "offered");
  const retained =
    (remounted.state.drafts.mode as { customValue?: string }).customValue;
  assertEquals(retained, "my custom value");
  remounted.text("mode", retained!);
  assertEquals(remounted.derive().answer.mode, "my custom value");
  forgetForm(input.id);
});
Deno.test("typed forms preserve false, numeric drafts, values not labels, hidden defaults and explicit external acknowledgement", () => {
  forgetForm(request.id);
  const f = createForm(request);
  f.text("rate", "");
  f.text("count", "1.4");
  f.set("enabled", false);
  f.set("tags", ["alpha", "custom entry"]);
  assert(f.derive().issues.rate);
  assert(f.derive().issues.count);
  assert(f.derive().issues.web);
  assertEquals(f.derive().answer.enabled, false);
  f.text("rate", "0.25");
  f.text("count", "2");
  f.set("web", true);
  assertEquals(f.derive().issues, {});
  assertEquals(f.derive().answer, {
    mode: "deploy",
    rate: .25,
    count: 2,
    enabled: false,
    tags: ["alpha", "custom entry"],
    secret: "supplied",
    dependent: "visible",
    web: true,
  });
  f.set("secret", "private override");
  f.set("mode", "later");
  assertEquals(f.derive().answer.secret, undefined);
  assertEquals(f.derive().answer.dependent, undefined);
  f.set("mode", "deploy");
  assertEquals(f.derive().answer.secret, "private override");
  const again = createForm(request);
  assertEquals(again.derive().answer, f.derive().answer);
  forgetForm(request.id);
});

Deno.test("reactive form values are copied without cloning proxies; unadded custom drafts survive replacement and block review", () => {
  const fields = [{
    key: "tags",
    type: "multiselect" as const,
    options: [],
    custom: true,
    default: new Proxy(["first"], {}),
  }];
  const proxy = new Proxy(["selected"], {});
  assertEquals(deriveForm(fields, { tags: { value: proxy } }).answer, {
    tags: ["selected"],
  });
  const input = { ...request, id: "custom-retention", fields };
  const form = createForm(input);
  form.customText("tags", "unfinished value");
  assert(form.derive().issues.tags);
  const remounted = createForm(input);
  assertEquals(remounted.state.drafts.tags.custom, "unfinished value");
  remounted.addCustom("tags");
  assertEquals(remounted.derive().answer.tags, ["first", "unfinished value"]);
  assertEquals(remounted.derive().issues, {});
  forgetForm(input.id);
});

Deno.test("form keys are data, including prototype names; unanswered conditions never read inherited properties", () => {
  const r: FormRequest = {
    ...request,
    id: "literal-keys",
    fields: [
      { key: "toString", type: "string" },
      {
        key: "__proto__",
        type: "string",
        default: "literal value",
        required: true,
      },
      {
        key: "conditional",
        type: "string",
        default: "must stay inactive",
        when: [{ key: "toString", op: "neq", value: "anything" }],
      },
    ],
  };
  const f = createForm(r);
  assertEquals(Object.entries(f.derive().answer), [[
    "__proto__",
    "literal value",
  ]]);
  assertEquals(Object.keys(f.derive().issues), []);
  forgetForm(r.id);
});
Deno.test("typed formats reject invalid dates and preserve date-time offsets; hidden required missing fields are exposed", () => {
  const r: FormRequest = {
    ...request,
    id: "format-fields",
    fields: [
      { type: "string", key: "email", format: "email" },
      { type: "string", key: "uri", format: "uri" },
      { type: "string", key: "date", format: "date" },
      { type: "string", key: "time", format: "date-time" },
      {
        type: "string",
        key: "pattern",
        pattern: "^[A-Z]+$",
        minLength: 2,
        maxLength: 5,
      },
      { type: "string", key: "hidden", hidden: true, required: true },
    ],
  };
  const f = createForm(r);
  f.text("email", "bad");
  f.text("uri", "bad");
  f.text("date", "2026-02-30");
  f.text("time", "bad");
  f.text("pattern", "x");
  assertEquals(Object.keys(f.derive().issues).length, 6);
  assert(f.derive().visible.some((x) => x.key === "hidden"));
  f.text("email", "a@example.com");
  f.text("uri", "https://example.com");
  f.text("date", "2026-02-28");
  f.text("time", "2026-11-09T12:30:00-08:00");
  f.text("pattern", "AB");
  f.text("hidden", "provided");
  assertEquals(f.derive().issues, {});
  assertEquals(f.derive().answer.time, "2026-11-09T12:30:00-08:00");
  forgetForm(r.id);
});
