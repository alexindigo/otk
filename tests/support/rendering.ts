// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import type { RawPart } from "@otk/harness-opencode-v1";
import type { Cdp } from "./cdp.ts";
import type { Script } from "./fake-llm.ts";
import { waitFor } from "./opencode.ts";
import type { browserFixture } from "./browser-fixture.ts";
export type RenderingFixture = Awaited<ReturnType<typeof browserFixture>>;
export function toolRow(part: RawPart): string {
  return `[data-message="${part.messageID}"] .otk-tool-line`;
}
/** Exercise lazy tool bodies through their real disclosure, not hidden DOM. */
export async function expandTool(
  browser: Cdp,
  selector: string,
): Promise<void> {
  const toggle = `${selector} .otk-tool-toggle`;
  await browser.poll(`!!document.querySelector(${JSON.stringify(toggle)})`);
  if (
    await browser.evaluate(
      `document.querySelector(${
        JSON.stringify(toggle)
      }).getAttribute('aria-expanded')==='false'`,
    )
  ) await browser.click(toggle);
  await browser.poll(
    `document.querySelector(${
      JSON.stringify(toggle)
    }).getAttribute('aria-expanded')==='true' && !!document.querySelector(${
      JSON.stringify(selector + " .otk-tool-body")
    })`,
  );
}
export async function runTool(
  f: RenderingFixture,
  browser: Cdp,
  id: string,
  tool: NonNullable<Script["tool"]>,
  extra?: { model?: { providerID: string; modelID: string } },
): Promise<RawPart> {
  const before = await f.oc.request<{ parts: RawPart[] }[]>(
    `/session/${id}/message`,
  );
  const old = new Set(before.flatMap((m) => m.parts).map((p) => p.id));
  f.fake.queue({ tool }, { chunks: [`Finished ${tool.name}.`] });
  if (extra) {
    await f.oc.request(`/session/${id}/prompt_async`, {
      method: "POST",
      body: { ...extra, parts: [{ type: "text", text: `Run ${tool.name}` }] },
    });
  } else {
    await browser.type("textarea[name=prompt]", `Run ${tool.name}`);
    await browser.key("Enter");
  }
  const part = await waitFor(
    () => f.oc.request<{ parts: RawPart[] }[]>(`/session/${id}/message`),
    (messages) =>
      messages.flatMap((m) => m.parts).some((p) =>
        !old.has(p.id) && p.type === "tool" && p.state?.status === "completed"
      ),
    60000,
  );
  const result = part.flatMap((m) => m.parts).find((p) =>
    !old.has(p.id) && p.type === "tool" && p.state?.status === "completed"
  )!;
  await browser.poll(
    `document.querySelector('[data-session="${id}"]').dataset.status==='idle'`,
    60000,
  );
  return result;
}
export async function recordTools(
  root: string,
  name: string,
  parts: RawPart[],
): Promise<void> {
  await Deno.writeTextFile(
    join(root, name + ".json"),
    JSON.stringify(parts, null, 2),
  );
}
