// SPDX-License-Identifier: LGPL-3.0-only
import { assert } from "@std/assert";
import { conventionErrors } from "./ui-conventions_test.ts";

/** Independent passing counterexamples from style review 5, not just old spellings. */
const cases: [Parameters<typeof conventionErrors>[0], string, string][] = [
  [
    "clock",
    "Fixture.tsx",
    "function dateLabel(at: Date) { return at.toLocaleString() }",
  ],
  ["clock", "components/Clock.tsx", "new Date(at).toLocaleString()"],
  [
    "icons",
    "Fixture.tsx",
    "function Icon() { return <svg><text>x</text></svg> }",
  ],
  [
    "icons",
    "Fixture.tsx",
    'function Icon() { return <span aria-hidden="true">v</span> }',
  ],
  [
    "icons",
    "Fixture.tsx",
    "interface Tool { icon: string }; function Avatar(props: { icon?: string }) { return <img src={props.icon} /> }; function ToolRow(props: Tool) { return <span>{props.icon}</span> }",
  ],
  [
    "icons",
    "Fixture.tsx",
    'const BadIcon = () => "x"; const row = { icon: BadIcon };',
  ],
  [
    "icons",
    "Fixture.tsx",
    'const art = () => "x"; const alias = art; const row = { icon: alias };',
  ],
  [
    "icons",
    "Fixture.tsx",
    'import { FakeIcon } from "./other/ChromeIcons.tsx"; const row = { icon: FakeIcon };',
  ],
  [
    "icons",
    "Fixture.tsx",
    'function BadIcon() { return "v" } const row = { icon: BadIcon };',
  ],
  [
    "icons",
    "Fixture.tsx",
    "const BadIcon = () => <span>x</span>; const row = { icon: BadIcon };",
  ],
  [
    "icons",
    "Fixture.tsx",
    "function Avatar(props: { icon?: string }) { return <><img src={props.icon} /><span>{props.icon}</span></> }",
  ],
  [
    "meta-tone",
    "Fixture.css",
    ".otk-reply-start { color: var(--otk-fg); font-weight: 500 }",
  ],
  ["meta-tone", "Fixture.css", ".consumer .otk-chrome-meta { color: red }"],
  ["masks", "Fixture.css", ".otk-tree-toggle rect { fill: #1a1a1a }"],
  [
    "native",
    "Fixture.tsx",
    'const D = "details"; const view = <Dynamic component={D} />',
  ],
  ["native", "Fixture.tsx", '<input type="checkbox" />'],
  ["native", "Fixture.tsx", 'document.createElement("summary")'],
  [
    "native",
    "Fixture.tsx",
    'function Preview(props: { preview?: boolean; label: string }, other: { preview?: boolean }) { return <button popovertarget="p" title={other.preview ? undefined : props.label} /> }',
  ],
  ["alignment", "Fixture.css", ".otk-send-failure { inline-size: 100% }"],
  [
    "alignment",
    "Fixture.css",
    ".otk-live-work-popover { width: min(360px, 80vw) }",
  ],
  [
    "alignment",
    "Fixture.css",
    ".otk-connection-status.has-failure { margin-left: 27px }",
  ],
  [
    "disclosure",
    "Fixture.css",
    ".otk-permission-scope { grid-template-columns: 19px auto; gap: 0 }",
  ],
  ["disclosure", "Fixture.css", ".otk-failure-details { padding-left: 8px }"],
  [
    "duration",
    "Fixture.tsx",
    "const elapsed = (ms: number) => `${Math.floor(ms / 1000)} s`",
  ],
  [
    "duration",
    "Fixture.tsx",
    "const second = 1000; const elapsed = (ms: number) => `${Math.floor(ms / second)} s`",
  ],
  [
    "duration",
    "components/format.ts",
    "export function duration(ms: number) { return `${ms / 1000} seconds` }",
  ],
  [
    "meta-list",
    "Fixture.tsx",
    '<div class="otk-chrome-meta"><span>·</span></div>',
  ],
  ["meta-list", "components/format.ts", 'const meta = values.join(" · ")'],
  [
    "meta-list",
    "Fixture.tsx",
    'const sep = " · "; const meta = values.join(sep)',
  ],
  [
    "meta-list",
    "Fixture.tsx",
    'import { ChromeMeta as Meta } from "@otk/ui"; const view = <Meta><span>·</span></Meta>',
  ],
  [
    "meta-list",
    "Fixture.tsx",
    "const view = <ChromeMeta>{`${count} · ${duration}`}</ChromeMeta>",
  ],
  [
    "meta-list",
    "Fixture.tsx",
    "const label = `${count} · ${elapsed}`; const alias = label; const view = <ChromeMeta>{alias}</ChromeMeta>",
  ],
  [
    "failure-signal",
    "Fixture.css",
    ".otk-prompt-chip.has-error { box-shadow: 0 0 0 1px red }",
  ],
  ["settings-name", "Fixture.tsx", 'const name = "Settings / " + "sidecars"'],
  [
    "presentation",
    "Fixture.tsx",
    'const data = { heading: "Made up", reason: "Wrong", tone: "error" }; const view = <FailureContent failure={data} />',
  ],
  [
    "presentation",
    "Fixture.tsx",
    'const data = { ...feedback.failure, tone: "neutral" };',
  ],
];
for (const [index, [rule, path, text]] of cases.entries()) {
  Deno.test(`UI review 5 bypass ${index + 1}: ${rule}`, () => {
    assert(conventionErrors(rule, path, text).length > 0, text);
  });
}
