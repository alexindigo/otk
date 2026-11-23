// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { nodes, property, type t } from "./syntax.ts";

const contract = "packages/protocol/inbox.ts";
const server = "core/index/entity-states.ts";
const client = "packages/client/entity-state.ts";
const states = new Set([
  "blocked",
  "working",
  "finished",
  "needsYou",
  "finishedUnseen",
]);
const replicaFiles = new Set([
  client,
  "packages/client/inbox.ts",
  "packages/client/index.ts",
]);

function symbols(source: Source): Set<string> {
  return new Set(
    source.all.flatMap((node) =>
      node.type === "Identifier"
        ? [node.name]
        : node.type === "StringLiteral"
        ? [node.value]
        : []
    ),
  );
}

function field(source: Source, node: t.Node): string | undefined {
  if (
    node.type !== "MemberExpression" &&
    node.type !== "OptionalMemberExpression"
  ) return;
  return node.computed ? source.string(node.property) : property(node.property);
}

function literalStates(source: Source, node: t.Node): Set<string> {
  return new Set([...nodes(node)].flatMap((item) => {
    // Label dictionaries and comparisons describe a state; they do not make one.
    const parent = source.parent.get(item);
    if (
      item.type !== "StringLiteral" || !states.has(item.value) ||
      parent?.type === "BinaryExpression" ||
      parent?.type === "ObjectProperty" && parent.key === item
    ) return [];
    return [item.value];
  }));
}

function independentProducers(source: Source): boolean {
  const produced = new Map<t.Node, Set<string>>();
  for (const node of source.all) {
    const value = node.type === "ReturnStatement"
      ? node.argument
      : node.type === "AssignmentExpression"
      ? node.right
      : node.type === "VariableDeclarator"
      ? node.init
      : node.type === "ArrowFunctionExpression" &&
          node.body.type !== "BlockStatement"
      ? node.body
      : undefined;
    if (!value) continue;
    const owner = source.function(node);
    if (!owner) continue;
    const values = produced.get(owner) ?? new Set<string>();
    // Do not attribute nested callbacks' output to their enclosing function.
    for (const item of nodes(value)) {
      if (
        item.type === "StringLiteral" && source.function(item) === owner &&
        literalStates(source, item).has(item.value)
      ) values.add(item.value);
    }
    produced.set(owner, values);
  }
  return [...produced.values()].some((values) => values.size > 1);
}

function priorityDefinitions(source: Source): boolean {
  const ranked = new Set([...states, "none"]);
  return source.all.some((node) => {
    const values = node.type === "ArrayExpression"
      ? node.elements.flatMap((e) =>
        e?.type === "StringLiteral" ? [e.value] : []
      )
      : node.type === "ObjectExpression"
      ? node.properties.flatMap((p) =>
        p.type === "ObjectProperty" && p.value.type === "NumericLiteral"
          ? [property(p.key) ?? ""]
          : []
      )
      : [];
    return new Set(values.filter((value) => ranked.has(value))).size > 1;
  });
}

function rawAttention(source: Source): boolean {
  return source.all.some((node) => {
    if (
      node.type !== "MemberExpression" &&
      node.type !== "OptionalMemberExpression"
    ) return false;
    const key = field(source, node);
    if (["supervision", "unseenCount", "errorState"].includes(key ?? "")) {
      return true;
    }
    if (
      ["work", "inputs", "permissions", "delivered"].includes(key ?? "") &&
      source.name(node.object)?.split(".").at(-1) === "activity"
    ) return true;
    // Native metadata fields share names with tool, HTTP and connection states.
    // Resolve aliases and typed metadata receivers, not those separate entities.
    if (!["status", "retry", "attention"].includes(key ?? "")) return false;
    // Callable retry belongs to a request/delivery resource, not native retry
    // evidence (which is a data object). Do not classify it by a local name.
    const parent = source.parent.get(node);
    if (
      key === "retry" &&
      (parent?.type === "CallExpression" ||
        parent?.type === "OptionalCallExpression") &&
      parent.callee === node
    ) return false;
    const parentField = parent ? field(source, parent) : undefined;
    const consumer = parent && source.parent.get(parent);
    if (
      key === "attention" &&
      (consumer?.type === "CallExpression" ||
        consumer?.type === "OptionalCallExpression") &&
      consumer.callee === parent
    ) return false; // RequestLifetimes methods, not metadata counters.
    if (
      key === "attention" &&
      [
        "permissions",
        "questions",
        "childPermissions",
        "childQuestions",
        "error",
      ]
        .includes(parentField ?? "")
    ) return true;
    if (
      key === "retry" &&
      ["attempt", "message", "next"].includes(parentField ?? "")
    ) return true;
    if (key === "status" && parent?.type === "BinaryExpression") {
      const other = parent.left === node ? parent.right : parent.left;
      if (["busy", "idle", "retry"].includes(source.string(other) ?? "")) {
        return true;
      }
    }
    const receiver = source.name(node.object) ?? "";
    const binding = source.access(node.object)?.binding;
    const typed = binding &&
      source.all.some((item) =>
        item.type === "Identifier" &&
        source.binding(item.name, item) === binding && item.typeAnnotation &&
        [...nodes(item.typeAnnotation)].some((type) =>
          type.type === "Identifier" &&
          /^(IndexMetadata|IndexEntry|MergedMetadata|SessionInfo)$/.test(
            type.name,
          )
        )
      );
    return !!typed ||
      /^(meta|metadata|entry|raw|known|deleted)$/.test(receiver);
  });
}

/** Only immutable caller inputs typed by the canonical owner can forward lamps.
 * Casts, local lookalike types, reassigned bindings and computed states do not
 * establish provenance. Trail construction itself is policed by trail-owner. */
function trailInputType(
  source: Source,
  node: t.Node | undefined,
): t.TSType | undefined {
  if (!node) return;
  if (node.type === "Identifier") {
    const access = source.access(node);
    if (!access || access.binding.value || access.binding.written) return;
    const scope = access.binding.scope;
    if (
      scope.type !== "FunctionDeclaration" &&
      scope.type !== "FunctionExpression" &&
      scope.type !== "ArrowFunctionExpression" &&
      scope.type !== "ObjectMethod" && scope.type !== "ClassMethod"
    ) return;
    const param = scope.params.find((param) =>
      param.type === "Identifier" &&
      source.binding(param.name, param) === access.binding
    );
    return param?.type === "Identifier" &&
        param.typeAnnotation?.type === "TSTypeAnnotation"
      ? param.typeAnnotation.typeAnnotation
      : undefined;
  }
  if (node.type === "CallExpression" && node.arguments.length === 0) {
    const type = trailInputType(source, node.callee);
    return type?.type === "TSFunctionType"
      ? type.typeAnnotation?.typeAnnotation
      : undefined;
  }
  if (node.type === "MemberExpression" && !node.computed) {
    const type = trailInputType(source, node.object);
    const name = property(node.property);
    const member = type?.type === "TSTypeLiteral"
      ? type.members.find((member) =>
        member.type === "TSPropertySignature" && property(member.key) === name
      )
      : undefined;
    return member?.type === "TSPropertySignature"
      ? member.typeAnnotation?.typeAnnotation
      : undefined;
  }
}
function canonicalTrailType(
  source: Source,
  type: t.TSType | undefined,
): boolean {
  if (type?.type === "TSIntersectionType") {
    return type.types.some((type) => canonicalTrailType(source, type));
  }
  if (type?.type !== "TSTypeReference") return false;
  const imported = source.imported(type.typeName);
  return imported?.module === "@otk/client" &&
    ["TrailCrumb", "TrailModel"].includes(imported.name);
}
function lampInput(source: Source, value: t.Node | undefined): boolean {
  const resolved = source.value(value);
  if (
    resolved?.type === "MemberExpression" && !resolved.computed &&
    property(resolved.property) === "status"
  ) {
    return canonicalTrailType(source, trailInputType(source, resolved.object));
  }
  if (!resolved || resolved.type !== "CallExpression") return false;
  const origin = source.imported(resolved.callee);
  return origin?.name === "lamp" &&
    ["@otk/client", "./entity-state.ts", "../entity-state.ts"].includes(
      origin.module,
    );
}

function timeAttention(source: Source): boolean {
  const imported = source.all.some((node) =>
    node.type === "ImportDeclaration" &&
    node.specifiers.some((specifier) =>
      specifier.type === "ImportSpecifier" &&
      ["ProjectStatus", "EntityState"].includes(
        property(specifier.imported) ?? "",
      )
    )
  );
  if (!imported) return false;
  return source.all.some((node) => {
    if (
      node.type === "CallExpression" &&
      ["setTimeout", "setInterval"].includes(
        source.name(node.callee)?.split(".").at(-1) ?? "",
      )
    ) return true;
    if (
      node.type !== "BinaryExpression" ||
      !["<", "<=", ">", ">="].includes(node.operator)
    ) return false;
    return [...nodes(node)].some((item) =>
      item.type === "Identifier" && item.name === "now" ||
      item.type === "CallExpression" && source.name(item.callee) === "Date.now"
    );
  });
}

function violations(path: string, text: string): string[] {
  const found = new Set<string>();
  if (/\.css$/.test(path)) {
    if (/(?:\.otk-age-|--otk-age-)/.test(text)) found.add("visit-age-paint");
    return [...found];
  }
  if (!/\.tsx?$/.test(path)) return [];
  const source = new Source(text, path);
  const names = symbols(source);
  if (path !== contract) {
    if (
      path !== server &&
      ["rollupStatus", "ROLLUP_PRIORITY"].some((s) => names.has(s))
    ) found.add("rollup-owner");
    if (
      path !== "core/features/navigation-default.ts" &&
      ["urgentStatus", "URGENCY_PRIORITY"].some((s) => names.has(s))
    ) found.add("urgency-owner");
    if (priorityDefinitions(source)) found.add("priority-definition");
  }
  if (!/^packages\/(?:client|ui)\//.test(path)) return [...found].sort();
  if (!replicaFiles.has(path) && rawAttention(source)) {
    found.add("raw-attention");
  }
  if (path !== client && independentProducers(source)) {
    found.add("state-producer");
  }
  for (const node of source.all) {
    if (
      node.type === "JSXOpeningElement" &&
      (source.name(node.name)?.split(".").at(-1) === "StatusLight" ||
        source.imported(node.name)?.name === "StatusLight") &&
      !lampInput(source, source.attr(node, "state"))
    ) found.add("lamp-input");
  }
  if (path !== client && timeAttention(source)) found.add("attention-clock");
  if (/(?:\.otk-age-|--otk-age-|otk-age-\$\{)/.test(text)) {
    found.add("visit-age-paint");
  }
  return [...found].sort();
}

// WP3.1 records existing violations. Each migration removes its entries. WP3.11
// removes this mechanism and requires an empty result, not an expanding allowlist.
const PENDING: string[] = [
  "packages/client/approval-attention.ts: raw-attention",
  "packages/client/inbox.ts: attention-clock",
  "packages/client/inbox.ts: rollup-owner",
  "packages/client/inbox.ts: state-producer",
  "packages/client/live-work.ts: raw-attention",
  "packages/client/notification-triggers.ts: raw-attention",
  "packages/client/project-projection.ts: raw-attention",
  "packages/client/project-projection.ts: rollup-owner",
  "packages/client/reduce.ts: raw-attention",
  "packages/client/request-attention.ts: rollup-owner",
  "packages/client/request-attention.ts: state-producer",
  "packages/client/server-resources.ts: raw-attention",
  "packages/client/tabs.ts: rollup-owner",
  "packages/client/transcript.ts: raw-attention",
  "packages/ui/components/EntityPill.tsx: lamp-input",
  "packages/ui/components/LiveWork.tsx: lamp-input",
  "packages/ui/components/LiveWork.tsx: state-producer",
  "packages/ui/components/ProjectInbox.tsx: lamp-input",
  "packages/ui/components/ProjectInbox.tsx: raw-attention",
  "packages/ui/components/ProjectInbox.tsx: visit-age-paint",
  "packages/ui/components/ProjectSessions.tsx: lamp-input",
  "packages/ui/components/ProjectSessions.tsx: raw-attention",
  "packages/ui/components/ProjectTabs.tsx: lamp-input",
  "packages/ui/components/ProjectTabs.tsx: raw-attention",
  "packages/ui/components/SessionView.tsx: raw-attention",
  "packages/ui/components/Sidebar.tsx: lamp-input",
  "packages/ui/components/Sidebar.tsx: raw-attention",
  "packages/ui/components/TakeoverHeader.tsx: lamp-input",
  "packages/ui/features/timeline.tsx: raw-attention",
  "packages/ui/shell/Shell.tsx: raw-attention",
  "packages/ui/shell/notifications.ts: raw-attention",
  "packages/ui/theme.css: visit-age-paint",
];

Deno.test("entity state ownership ratchets every existing independent computation", async () => {
  const found: string[] = [];
  for (const [path, text] of await productionSources()) {
    for (const rule of violations(path, text)) found.push(`${path}: ${rule}`);
  }
  assertEquals(found.sort(), PENDING);
});

Deno.test("entity state ownership catches priority copies and crossed owners", () => {
  for (
    const text of [
      'import { rollupStatus as choose } from "@otk/protocol";',
      'import * as p from "@otk/protocol"; p["ROLLUP_PRIORITY"];',
    ]
  ) {
    assert(
      violations("packages/client/example.ts", text).includes("rollup-owner"),
    );
  }
  for (
    const text of [
      'const rank = ["finished", "none", "blocked", "working"];',
      "const rank = { finished: 0, working: 1, blocked: 2, none: 3 };",
    ]
  ) assert(violations("core/example.ts", text).includes("priority-definition"));
  const urgency = 'import { urgentStatus as choose } from "@otk/protocol";';
  assertEquals(violations("core/features/navigation-default.ts", urgency), []);
  assertEquals(violations("packages/client/example.ts", urgency), [
    "urgency-owner",
  ]);
  assertEquals(
    violations(server, 'import {rollupStatus} from "@otk/protocol";'),
    [],
  );
  assertEquals(
    violations(contract, 'const rank = ["working", "finished"];'),
    [],
  );
  assertEquals(
    violations(
      "core/example.ts",
      'const labels = {working: "Working", finished: "Finished"};',
    ),
    [],
  );
});

Deno.test("entity state ownership detects raw metadata including aliases without banning separate entity states", () => {
  for (
    const text of [
      'meta.status === "busy";',
      'const copy = meta; copy["retry"];',
      "function f(row: IndexMetadata) { return row.attention.permissions; }",
      "entry().attention.childPermissions;",
      'source.lookup(id).status === "busy";',
      "const copy = source.lookup(id).retry?.attempt;",
      "inbox.supervision?.[id];",
      "summary.unseenCount;",
      "row.activity.work;",
      'row.activity["inputs"];',
      "entry.errorState;",
    ]
  ) {
    assert(
      violations("packages/client/example.ts", text).includes("raw-attention"),
    );
  }
  for (
    const text of [
      'tool.status === "running";',
      "response.status === 404;",
      'connection.status === "connected";',
      "owner.attention;",
      "connection.attention.permissions(id, lookup, true);",
      "entry.retry?.();",
    ]
  ) assertEquals(violations("packages/client/example.ts", text), []);
  assertEquals(violations(client, "meta.status; inbox.supervision;"), []);
  assertEquals(violations("packages/client/index.ts", "meta.status;"), []);
});

Deno.test("entity state ownership detects independent state production, not labels or comparisons", () => {
  for (
    const text of [
      'function choose() { return ready ? "working" : "blocked"; }',
      'const choose = () => ready ? "finished" : "working";',
      'function choose() { let state = "working"; if (ask) state = "blocked"; return state; }',
      'function choose() { if (a) return "needsYou"; return "finishedUnseen"; }',
    ]
  ) {
    assert(
      violations("packages/client/example.ts", text).includes("state-producer"),
    );
  }
  for (
    const text of [
      'const labels = {working: "Working", blocked: "Needs you"};',
      'function inspect() { return state === "working" || state === "blocked"; }',
      'function outer() { const a = () => "working"; const b = () => "blocked"; return [a,b]; }',
      'const outcomes = {failed: "error", completed: "success"};',
    ]
  ) assertEquals(violations("packages/client/example.ts", text), []);
});

Deno.test("entity state lamps require the selector, directly or through its binding", () => {
  for (
    const text of [
      '<StatusLight state="blocked" />;',
      'import Light from "./StatusLight.tsx"; <Light state="working" />;',
      "<StatusLight state={row.status} />;",
      'const lamp = () => "working"; <StatusLight state={lamp()} />;',
      'import {StatusLight as Light} from "@otk/ui"; <Light state="blocked" />;',
      'import {lamp} from "@otk/client"; let state = lamp(store,key,options); state = other; <StatusLight state={state} />;',
    ]
  ) assert(violations("packages/ui/example.tsx", text).includes("lamp-input"));
  for (
    const text of [
      'import {lamp} from "@otk/client"; <StatusLight state={lamp(store,key,options)} />;',
      'import {lamp as select} from "@otk/client"; const state = select(store,key,options); <StatusLight state={state} />;',
      'import * as model from "@otk/client"; <StatusLight state={model.lamp(store,key,options)} />;',
    ]
  ) assertEquals(violations("packages/ui/example.tsx", text), []);
});

Deno.test("entity state lamps accept canonical trail input provenance, never lookalikes or casts", () => {
  for (
    const text of [
      'import type {TrailCrumb as Crumb} from "@otk/client"; function view(row: Crumb) { return <StatusLight state={row.status} />; }',
      'import type {TrailCrumb} from "@otk/client"; const view = (row: () => TrailCrumb) => <StatusLight state={row().status} />;',
      'import type {TrailCrumb} from "@otk/client"; const view = (row: TrailCrumb & {key: string}) => <StatusLight state={row.status} />;',
      'import type {TrailModel} from "@otk/client"; function view(props: {model: TrailModel}) { return <StatusLight state={props.model.status} />; }',
      'import type {TrailCrumb} from "@otk/client"; function view(row: TrailCrumb) { const state = row.status; return <StatusLight state={state} />; }',
    ]
  ) assertEquals(violations("packages/ui/arbitrary.tsx", text), []);
  for (
    const text of [
      "type TrailCrumb = {status: string}; function view(row: TrailCrumb) { return <StatusLight state={row.status} />; }",
      'import type {TrailCrumb} from "elsewhere"; function view(row: TrailCrumb) { return <StatusLight state={row.status} />; }',
      'import type {TrailCrumb} from "@otk/client"; const row = raw as TrailCrumb; <StatusLight state={row.status} />;',
      'import type {TrailCrumb} from "@otk/client"; function view(row: TrailCrumb) { row.status = "working"; return <StatusLight state={row.status} />; }',
      'import type {TrailCrumb} from "@otk/client"; function view(row: TrailCrumb) { return <StatusLight state={row.status === "none" ? "working" : row.status} />; }',
    ]
  ) {
    assert(
      violations("packages/ui/arbitrary.tsx", text).includes("lamp-input"),
    );
  }
});

Deno.test("entity state timing rejects attention clocks and visit-age paint", () => {
  for (
    const text of [
      'import type {ProjectStatus} from "@otk/protocol"; setTimeout(paint, 500);',
      'import type {EntityState as State} from "@otk/protocol"; window.setInterval(paint, 500);',
      'import type {ProjectStatus} from "@otk/protocol"; const aged = now - visit > 100;',
      'import type {EntityState} from "@otk/protocol"; const aged = Date.now() - visit >= 100;',
    ]
  ) {
    assert(
      violations("packages/client/example.ts", text).includes(
        "attention-clock",
      ),
    );
  }
  assertEquals(
    violations(
      client,
      'import type {EntityState} from "@otk/protocol"; now - since < 500;',
    ),
    [],
  );
  assertEquals(
    violations("packages/ui/example.tsx", "const name = `otk-age-${age}`;"),
    ["visit-age-paint"],
  );
  assertEquals(
    violations(
      "packages/ui/theme.css",
      ".otk-age-1 { color: var(--otk-age-1); }",
    ),
    ["visit-age-paint"],
  );
  assertEquals(
    violations(
      "packages/ui/theme.css",
      ".visit-clock { color: var(--muted); }",
    ),
    [],
  );
});
