// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { toggle } from "../components/selection.ts";

Deno.test("binary on state binds pressed semantics without selection marks", () => {
  for (const on of [false, true]) {
    const state = toggle({ on, class: "control" });
    assertEquals(state["aria-pressed"], String(on));
    assertEquals(state.class, `control otk-toggle${on ? " is-on" : ""}`);
    assert(!/selection|selected/.test(JSON.stringify(state)));
  }
});

Deno.test("toggle consumers cannot acquire selection marks; native switches and disclosures stay distinct from panel choices", async () => {
  const read = (path: string) =>
    Deno.readTextFile(new URL(`../${path}`, import.meta.url));
  const auto = await read("features/prompt/approvals.tsx");
  assert(auto.includes("...toggle({"));
  assert(!/selection\(|SelectionContent|data-otk-selection/.test(auto));
  const controls = await read("components/PreferenceControls.tsx");
  assert(controls.includes('type="checkbox"'));
  assert(!/selection\(|data-otk-selection/.test(controls));
  const shell = await read("shell/Shell.tsx");
  for (const match of shell.matchAll(/<button\b[\s\S]*?<\/button>/g)) {
    if (!match[0].includes("aria-expanded=")) continue;
    assert(!/selection\(|data-otk-selection/.test(match[0]));
  }
  const panel = await read("components/RightPanel.tsx");
  assert(panel.includes('kind: "selected"'));
  assert(panel.includes("...selection({"));
  assert(panel.includes("data-otk-selection="));
});
