// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { FailurePresenter } from "../../packages/client/failures.ts";
import { duration, humanDuration } from "../../packages/client/format.ts";
import { runningWorkElapsed } from "../../packages/client/live-work.ts";
import { productionSources, Source } from "./analysis.ts";
import { property, type t } from "./syntax.ts";
import { rules } from "./styles.ts";

type Rule =
  | "clock"
  | "icons"
  | "ellipsis"
  | "meta-tone"
  | "masks"
  | "native"
  | "alignment"
  | "disclosure"
  | "duration"
  | "meta-list"
  | "failure-signal"
  | "settings-name";
const owners: Record<Rule, string> = {
  clock:
    "Local date/time formatting belongs to Clock (including precise records)",
  icons:
    "Real icons only: use an icon component or StateShape, never text glyphs",
  ellipsis: "Interface progress/truncation uses ASCII three dots, never U+2026",
  "meta-tone":
    "Metadata is plain ChromeMeta; error tone belongs to FailureSignal, icons or count badges",
  masks:
    "Structure over paint masks: end Tree guides at their junction/artwork cell",
  native:
    "Decision 54: use DisclosureToggle, Select/ListPicker and Popover, not browser-native widgets",
  alignment:
    "Structural alignment: use shared grid/subgrid tracks and intrinsic sizing, not compensating offsets/ratios",
  disclosure:
    "DisclosureToggle owns tracks, gap and padding; consumers supply only its gutter input",
  duration:
    "One duration format: use the client duration owner, never a local elapsed formatter",
  "meta-list":
    "One metadata join: use ChromeMeta's metaList, not separate flex-item separators",
  "failure-signal":
    "One failure signal: use FailureSignal, not a red chip outline",
  "settings-name":
    "One surface name: navigation says Settings / servers, matching Settings",
};
const containsStringType = (node: t.Node): boolean => {
  if (node.type === "TSStringKeyword") return true;
  return Object.values(node).some((value) =>
    (Array.isArray(value) ? value : [value]).some((child) =>
      child && typeof child === "object" && "type" in child &&
      containsStringType(child as t.Node)
    )
  );
};
const elementName = (node: t.JSXOpeningElement) =>
  node.name.type === "JSXIdentifier" ? node.name.name : "";

/** Syntax-aware checks are exported so their reject/accept cases stay executable.
 * Owner exceptions name real responsibilities, never individual violations. */
export function conventionErrors(
  rule: Rule,
  path: string,
  text: string,
): string[] {
  const errors: string[] = [];
  const fail = (where: string) =>
    errors.push(`${path}: ${where}: ${owners[rule]}`);
  if (rule === "ellipsis" && /\u2026|\\u2026|\\u\{2026\}/iu.test(text)) {
    fail("U+2026 in source");
  }
  if (path.endsWith(".css")) {
    for (const { selector, declarations: d } of rules(text)) {
      if (
        rule === "ellipsis" &&
        [...d.values()].some((value) => value.includes("\u2026"))
      ) fail(selector);
      if (
        rule === "icons" &&
        /icon|glyph|toggle|close|marker|disclosure/.test(selector) &&
        /^['"][^'"\s]+['"]$/.test(d.get("content") ?? "")
      ) fail(selector);
      if (
        rule === "meta-tone" &&
        /meta|record-group-(?:count|time|failures)|record-summary|elapsed/.test(
          selector,
        ) &&
        /danger|status-error/.test(d.get("color") ?? "")
      ) fail(selector);
      if (
        rule === "masks" &&
        /tree-(?:toggle|junction|icon-art)|disclosure/.test(selector) &&
        ["fill", "background", "background-color"].some((key) =>
          /var\(--(?:otk-)?bg/.test(d.get(key) ?? "")
        )
      ) fail(selector);
      if (
        rule === "alignment" &&
        /connection-status.*has-failure/.test(selector) &&
        [...d].some(([key, value]) =>
          /gutter|inset|margin|padding/.test(key) && /calc\(/.test(value)
        )
      ) fail(selector);
      if (
        rule === "alignment" && /send-failure/.test(selector) &&
        (d.get("justify-self") === "stretch" ||
          [...d].some(([key, value]) =>
            /(?:inline-size|width)/.test(key) && /\d+%/.test(value) &&
            value !== "100%"
          ))
      ) fail(selector);
      if (
        rule === "alignment" && /failure-heading/.test(selector) &&
        /\d+%/.test(d.get("max-inline-size") ?? "")
      ) fail(selector);
      if (
        rule === "disclosure" && /failure-details/.test(selector) &&
        [
          "grid-template-columns",
          "column-gap",
          "gap",
          "padding",
          "padding-inline",
        ].some((key) => d.has(key))
      ) fail(selector);
      if (
        rule === "failure-signal" &&
        /chip.*(?:has-error|is-error)/.test(selector) &&
        [...d].some(([key, value]) =>
          /border|outline/.test(key) && /danger|status-error/.test(value)
        )
      ) fail(selector);
    }
    return errors;
  }
  const source = new Source(text, path);
  if (rule === "settings-name" && /Settings \/ sidecars/.test(text)) {
    fail("navigation label");
  }
  const imageSource = source.all.some((node) =>
    node.type === "JSXOpeningElement" &&
    elementName(node) === "img" && node.attributes.some((attr) =>
      attr.type === "JSXAttribute" &&
      property(attr.name) === "src" &&
      attr.value?.type === "JSXExpressionContainer" &&
      attr.value.expression.type === "MemberExpression" &&
      property(attr.value.expression.property) === "icon"
    )
  );
  for (const node of source.all) {
    if (
      rule === "ellipsis" &&
      ((node.type === "StringLiteral" || node.type === "JSXText") &&
          node.value.includes("\u2026") ||
        node.type === "TemplateElement" &&
          node.value.cooked?.includes("\u2026"))
    ) fail(`line ${node.loc?.start.line}`);
    if (rule === "clock" && !path.endsWith("/Clock.tsx")) {
      if (
        (node.type === "CallExpression" || node.type === "NewExpression") &&
        node.callee.type === "MemberExpression"
      ) {
        const method = property(node.callee.property);
        const options = node.arguments.map((arg) =>
          text.slice(arg.start!, arg.end!)
        ).join(" ");
        // Numeric locale formatting is not a date formatter. Date options and
        // Date-valued receivers distinguish it without exempting file paths.
        const receiver = source.value(node.callee.object);
        if (
          ["toLocaleDateString", "toLocaleTimeString", "DateTimeFormat"]
            .includes(method ?? "") ||
          method === "toLocaleString" &&
            (/year|month|day|hour|minute|second|timeZone/i.test(options) ||
              receiver?.type === "NewExpression" &&
                source.name(receiver.callee) === "Date")
        ) fail(`line ${node.loc?.start.line}`);
      }
    }
    if (rule === "icons") {
      if (
        node.type === "TSPropertySignature" && property(node.key) === "icon" &&
        node.typeAnnotation && containsStringType(node.typeAnnotation) &&
        !(imageSource &&
          node.typeAnnotation.typeAnnotation.type === "TSStringKeyword")
      ) fail(`icon type on line ${node.loc?.start.line}`);
      if (
        (node.type === "ObjectProperty" && property(node.key) === "icon" &&
          source.string(node.value) !== undefined) ||
        (node.type === "JSXAttribute" && property(node.name) === "icon" &&
          source.string(node.value) !== undefined)
      ) fail(`icon value on line ${node.loc?.start.line}`);
      if (
        (node.type === "StringLiteral" || node.type === "JSXText") &&
        /^[\s\[\]✓•⌕◇↳↓☑◐×]+$/.test(node.value) &&
        /[✓•⌕◇↳↓☑◐×]/.test(node.value)
      ) fail(`glyph on line ${node.loc?.start.line}`);
    }
    if (rule === "native" && node.type === "JSXOpeningElement") {
      const name = elementName(node);
      if (["details", "summary", "select"].includes(name)) {
        fail(`<${name}> on line ${node.loc?.start.line}`);
      }
      // Preview surfaces have their own hover/focus detail; title elsewhere is
      // still the documented full-value/name affordance, not a second preview.
      const previewOwner = source.all.some((item) =>
        item.type === "TSPropertySignature" && property(item.key) === "preview"
      );
      const nativeTarget = node.attributes.some((attr) =>
        attr.type === "JSXAttribute" && property(attr.name) === "popovertarget"
      );
      const title = node.attributes.find((attr) =>
        attr.type === "JSXAttribute" && property(attr.name) === "title"
      );
      if (
        name === "button" && previewOwner && nativeTarget &&
        title?.type === "JSXAttribute"
      ) {
        const value = title.value?.type === "JSXExpressionContainer"
          ? title.value.expression
          : undefined;
        const guarded = value?.type === "ConditionalExpression" &&
          value.test.type === "MemberExpression" &&
          property(value.test.property) === "preview" &&
          value.consequent.type === "Identifier" &&
          value.consequent.name === "undefined";
        if (!guarded) {
          fail(`native preview tooltip on line ${node.loc?.start.line}`);
        }
      }
    }
    if (
      rule === "duration" && !path.endsWith("/format.ts") &&
      node.type === "FunctionDeclaration" &&
      /^(?:runningWorkElapsed|humanDuration|duration)$/.test(
        node.id?.name ?? "",
      ) &&
      source.all.some((child) =>
        child.start! > node.start! && child.end! < node.end! &&
        child.type === "BinaryExpression" && child.operator === "/"
      )
    ) fail(`local duration on line ${node.loc?.start.line}`);
    if (
      rule === "meta-list" && node.type === "JSXElement" &&
      elementName(node.openingElement) === "ChromeMeta" &&
      node.children.some((child) =>
        child.type === "JSXText" && child.value.trim() === "·"
      )
    ) fail(`separator on line ${node.loc?.start.line}`);
    if (
      rule === "meta-list" && !path.endsWith("/format.ts") &&
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      property(node.callee.property) === "join" &&
      source.string(node.arguments[0]) === " · "
    ) fail(`local metadata join on line ${node.loc?.start.line}`);
  }
  if (
    rule === "duration" && path.endsWith("/format.ts") &&
    /export function humanDuration/.test(text) &&
    /return `\$\{Math\.floor\(elapsed \/ 1000\)\} s`/.test(text)
  ) fail("humanDuration formats seconds separately from duration");
  return errors;
}

for (const rule of Object.keys(owners) as Rule[]) {
  Deno.test(`UI convention: ${owners[rule]}`, async () => {
    const failures: string[] = [];
    for (const [path, text] of await productionSources()) {
      if (/^(?:packages\/(?:client|ui)\/|web\/src\/)/.test(path)) {
        failures.push(...conventionErrors(rule, path, text));
      }
    }
    assertEquals(failures, [], failures.join("\n"));
    if (rule === "duration") {
      for (const elapsed of [0, 1234, 65000]) {
        assertEquals(
          humanDuration(elapsed),
          duration(elapsed),
          owners.duration,
        );
        assertEquals(
          runningWorkElapsed(elapsed),
          duration(elapsed),
          owners.duration,
        );
      }
    }
    if (rule === "meta-tone") {
      const meta = rules(
        await Deno.readTextFile(
          new URL(
            "../../packages/ui/components/ChromeMeta.css",
            import.meta.url,
          ),
        ),
      )
        .find((rule) => rule.selector === ".otk-chrome-meta")!;
      assertEquals(
        meta.declarations.get("font-weight"),
        "400",
        "ChromeMeta owns the same weight inside and outside controls",
      );
      assertEquals(
        meta.declarations.get("color"),
        "var(--otk-fg-3)",
        owners["meta-tone"],
      );
    }
  });
}

Deno.test("UI convention: failure presenter drops current-session targets on every inline surface, notifications retain them", () => {
  const target = {
    sidecarId: "local",
    sessionID: "current",
    label: "Open session",
  };
  const presenter = new FailurePresenter({
    target: () => ({ label: target.label, href: "/current" }),
  });
  const value = {
    code: "test.failure",
    retry: "none" as const,
    diagnosticID: "test",
    facts: { actionLabel: "Sending prompt", target, reason: "Refused" },
  };
  for (
    const surface of ["record", "feedback", "session", "notification"] as const
  ) {
    const shown = presenter.describe(value, { surface, view: target }).failure!;
    assertEquals(
      shown.target,
      surface === "notification"
        ? { label: target.label, href: "/current" }
        : { label: "" },
      `FailurePresenter must drop self-links for ${surface}`,
    );
  }
});

Deno.test("UI convention: unknown outcomes have neutral tone derived by FailurePresenter, never the failure stripe", () => {
  const shown = new FailurePresenter().describe({
    code: "test.pending",
    retry: "none",
    diagnosticID: "pending",
    facts: { outcome: "unknown", actionLabel: "Sending prompt" },
  });
  assertEquals(shown.kind, "pending");
  assertEquals(
    shown.failure?.tone,
    "neutral",
    "FailurePresenter owns tone from outcome, not the caller",
  );
});

Deno.test("UI convention: attachment fixtures and the app use the same file-target failure builder", async () => {
  for (
    const path of [
      "packages/ui/features/prompt/attachments.tsx",
      "packages/ui/tests/style-consumer/error-surfaces.tsx",
    ]
  ) {
    const text = await Deno.readTextFile(
      new URL(`../../${path}`, import.meta.url),
    );
    assert(
      text.includes("attachmentFailure("),
      `${path}: use attachmentFailure with the file identity, never a hand-authored session target`,
    );
  }
});

Deno.test("UI convention gates distinguish artwork, numeric locales and intrinsic layout from violations", () => {
  const bad: [Rule, string, string][] = [
    ["clock", "Fixture.tsx", "new Date(at).toLocaleString()"],
    ["clock", "Fixture.tsx", "instant.toLocaleTimeString()"],
    [
      "icons",
      "Fixture.tsx",
      'interface Tool { icon: string | (() => Element) }; const row = { icon: "?" };',
    ],
    ["icons", "Fixture.tsx", '<span aria-hidden="true">✓</span>'],
    ["ellipsis", "Fixture.tsx", 'const text = "Loading\\u2026";'],
    [
      "meta-tone",
      "Fixture.css",
      ".otk-record-group-failures { color: var(--danger) }",
    ],
    ["masks", "Fixture.css", ".otk-tree-toggle rect { fill: var(--otk-bg) }"],
    ["native", "Fixture.tsx", "<details><summary>Details</summary></details>"],
    ["native", "Fixture.tsx", "<select />"],
    [
      "native",
      "Fixture.tsx",
      'function Preview(props: {preview?: boolean}) { return <button popovertarget="p" title="Native tooltip" />; }',
    ],
    [
      "alignment",
      "Fixture.css",
      ".otk-connection-status.has-failure { --failure-gutter: calc(var(--control-size) + var(--space-2)) }",
    ],
    ["alignment", "Fixture.css", ".otk-send-failure { inline-size: 80% }"],
    [
      "disclosure",
      "Fixture.css",
      ".otk-failure-details { grid-template-columns: 19px auto }",
    ],
    ["meta-list", "Fixture.tsx", "<ChromeMeta>·</ChromeMeta>"],
  ];
  for (const [rule, path, text] of bad) {
    assert(conventionErrors(rule, path, text).length > 0, `${rule}: ${text}`);
  }
  assertEquals(
    conventionErrors("clock", "Fixture.tsx", "bytes.toLocaleString()"),
    [],
  );
  assertEquals(
    conventionErrors(
      "icons",
      "Fixture.tsx",
      'const tool = { icon: SearchIcon }; const icon = <svg><path d="M1 1h8" /></svg>;',
    ),
    [],
  );
  assertEquals(
    conventionErrors(
      "icons",
      "Fixture.tsx",
      "function Avatar(props: { icon?: string }) { return <img src={props.icon} />; }",
    ),
    [],
  );
  assertEquals(
    conventionErrors(
      "alignment",
      "Fixture.css",
      ".otk-connection-status.has-failure { grid-template-columns: subgrid } .otk-send-failure { inline-size: fit-content; max-inline-size: 100% }",
    ),
    [],
  );
  assertEquals(
    conventionErrors(
      "alignment",
      "Fixture.css",
      ".otk-user-message { --user-column: 80% }",
    ),
    [],
  );
});
