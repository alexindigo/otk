// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import type { Message, Part } from "@otk/protocol";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { seed } from "../../pages/attention.ts";
import { revealAcquired, scrollTranscript } from "../../pages/transcript.ts";
import { treeLaneFindings } from "../tree-lanes-contract.ts";

/** Add representative work to the running-layout scene's published reply. */
async function includeNestedWork(page: Page) {
  const time = { start: 2, end: 3 };
  const parts: Part[] = [{
    id: "lane-reasoning",
    kind: "reasoning",
    time,
    blocks: [{
      b: "paragraph",
      inline: [{ i: "text", text: "Reviewed the current run." }],
    }],
  }, {
    id: "lane-tool",
    kind: "tool",
    call: {
      tool: "external",
      name: "Inspect logs",
      summary: "Inspect the sample log",
      callID: "lane-tool",
      status: "error",
      failure: { message: "The sample log was unavailable" },
      output: "Partial tool output",
      time,
      children: [{
        tool: "bash",
        callID: "lane-child",
        command: "printf summary",
        output: "summary",
        status: "completed",
        time,
      }],
    },
  }];
  await page.routeWebSocket("**/ws", (client) => {
    const server = client.connectToServer();
    server.onMessage((data) => {
      const frame = JSON.parse(data.toString());
      const items: Message[] | undefined = frame.t === "load.chunk" &&
          frame.data.kind === "message-page"
        ? frame.data.page?.items
        : frame.t === "request.result" && frame.outcome.ok
        ? frame.outcome.result?.items
        : undefined;
      const reply = items?.find((message) =>
        message.role === "assistant" && message.id === "answer"
      );
      if (reply) reply.parts.push(...parts);
      client.send(reply ? JSON.stringify(frame) : data);
    });
  });
}

for (const zoom of [1, 1.25, 1.5, 1.75, 2]) {
  test.describe(`${zoom * 100}%`, () => {
    test.use({
      viewport: {
        width: Math.round(1684 / zoom),
        height: Math.round(1300 / zoom),
      },
      deviceScaleFactor: zoom,
    });
    for (const tree of ["projects", "sessions"] as const) {
      test.describe(tree, () => {
        test.use({
          profile: tree === "projects"
            ? "contract-sessions-sidebar"
            : "isolated",
        });
        for (const root of [13, 20]) {
          test(
            `visual.tree-lanes.${zoom * 100}.${tree}${
              root === 20 ? ".root20" : ""
            }`,
            { tag: ["@visual", "@isolated"] },
            async ({ isolatedState: state, page }) => {
              await state.product("prefs.set", {
                key: "animationsOff",
                value: true,
              });
              await state.product("layout.patch", {
                leftWidth: 248,
                leftCollapsed: false,
                rightWidth: 320,
                rightCollapsed: false,
                rightView: "sessions",
              });
              const side = tree === "projects" ? "left" : "right";
              const list = page.locator(
                `.otk-sidebar-rail[data-side="${side}"]`,
              );
              if (tree === "projects") {
                await openSession(state, page, "tstv1-sidebar-all-required-0");
                const { root } = await state.observe<{ root: string }>();
                const project = (name: string) =>
                  list.locator(
                    `.otk-project-row[data-project=${
                      JSON.stringify(`${root}/sidebar/${name}`)
                    }]`,
                  );
                const parent = project("all-required");
                const child = project("all-required-child-0");
                await expect(parent).toBeVisible();
                if (!await child.isVisible()) {
                  await parent.locator("xpath=ancestor::*[@data-tree-node][1]")
                    .locator(".otk-tree-toggle").click();
                }
                await expect(child).toBeVisible();
                await expect(list.locator(".otk-archived-toggle").first())
                  .toBeVisible();
              } else {
                const parent = await seed(
                  state,
                  "Execution and dependency review",
                );
                const child = await seed(
                  state,
                  "Validate the release configuration",
                  parent.id,
                );
                await seed(
                  state,
                  "Review the reporting and evaluation contracts",
                  parent.id,
                );
                await seed(
                  state,
                  "Summarize the browser verification evidence",
                  parent.id,
                );
                const grandchild = await seed(
                  state,
                  "Confirm the transitive dependency inventory",
                  child.id,
                );
                await openSession(state, page, parent.id);
                await expect(list.locator(`[data-session="${parent.id}"]`))
                  .toHaveClass(/is-selected/);
                await expect(list.locator(`[data-session="${grandchild.id}"]`))
                  .toBeVisible();
              }
              if (root === 20) {
                await page.addStyleTag({ content: ":root{font-size:20px}" });
              }
              await expect.poll(() => treeLaneFindings(list)).toEqual([]);
            },
          );
        }
      });
    }
    for (const direction of ["incoming", "outgoing"] as const) {
      test.describe(`transcript ${direction}`, () => {
        test.use({
          profile: direction === "incoming"
            ? "contract-messages-running-layout"
            : "contract-messages-v1-notices",
        });
        for (const root of [13, 20]) {
          test(
            `visual.tree-lanes.${zoom * 100}.transcript-${direction}${
              root === 20 ? ".root20" : ""
            }`,
            { tag: ["@visual", "@isolated"] },
            async ({ isolatedState: state, page }) => {
              if (root === 20) {
                await page.addInitScript(() => {
                  document.addEventListener("DOMContentLoaded", () => {
                    document.documentElement.style.fontSize = "20px";
                  });
                });
              }
              if (direction === "incoming") {
                await includeNestedWork(page);
                const { session } = await state.observe<{ session: string }>();
                await openSession(state, page, session);
                await state.product("layout.patch", { rightCollapsed: true });
                await expect(
                  page.locator('.otk-sidebar-rail[data-side="right"]'),
                )
                  .toHaveAttribute("data-collapsed", "true");
                for (let n = 0; n < 3; n++) {
                  await state.controller.call("scenario", {
                    lease: state.lease.lease,
                    action: "freeze",
                  });
                }
                await page.reload();
                const span = page.locator(".otk-record-group").first();
                await expect(span).toHaveAttribute("data-count", "3");
                await span.locator(".otk-record-group-toggle").first().click();
                await span.locator(".otk-record-group .otk-record-group-toggle")
                  .click();
                await expect(span.locator("[data-role=context]")).toHaveCount(
                  3,
                );
                await expect(span.locator(
                  "button.otk-tree-trigger.otk-record-group-toggle",
                )).toHaveCount(2);
                await expect.poll(() => treeLaneFindings(span)).toEqual([]);
                const record = span.locator(
                  '[data-native-record="fixture/record"]',
                ).first();
                await record.locator(".otk-tool-toggle").first().click();
                await record.getByRole("button", {
                  name: "Source",
                  exact: true,
                }).click();
                await expect(record.locator(".otk-native-preview"))
                  .toBeVisible();
                await scrollTranscript(page, true);
                await expect(span.locator("[data-role=context]")).toHaveCount(
                  3,
                );
                await expect.poll(() => treeLaneFindings(span)).toEqual([]);

                const work = page.locator(".otk-work-log");
                await revealAcquired(page, ".otk-work-log .otk-work-fold");
                const workToggle = work.locator(".otk-work-fold");
                if (
                  await workToggle.getAttribute("aria-expanded") === "false"
                ) await workToggle.click();
                const tool = work.locator('[data-tool="external"]');
                await tool.locator(".otk-tool-toggle").first().click();
                await expect(tool.locator(".otk-tool-body")).toContainText(
                  "Partial tool output",
                );
                await expect(tool.locator('[data-tool="bash"]')).toBeVisible();
                await expect(tool.locator(".otk-failure-main-reason"))
                  .toContainText("The sample log was unavailable");
                await work.locator(".otk-reasoning-heading").click();
                await expect(work.locator(".otk-reasoning-body")).toContainText(
                  "Reviewed the current run.",
                );
                await expect.poll(() => treeLaneFindings(work)).toEqual([]);
              } else {
                await openSession(state, page, "tstv1-otk");
                await state.product("layout.patch", { rightCollapsed: true });
                await expect(
                  page.locator('.otk-sidebar-rail[data-side="right"]'),
                )
                  .toHaveAttribute("data-collapsed", "true");
                await scrollTranscript(page, false);
                const selector = '[data-message="context"] .otk-tree-node';
                await revealAcquired(page, selector);
                const record = page.locator('[data-message="context"]');
                await record.getByRole("button", { name: "Outgoing context" })
                  .click();
                await expect(
                  record.getByText("Context prepared by the harness"),
                )
                  .toBeVisible();
                const outgoing = record.locator(
                  "xpath=ancestor::section[@data-record-members][1]",
                );
                await expect(record.getByRole("button", {
                  name: "Outgoing context",
                })).toHaveClass(/otk-tree-trigger/);
                await expect.poll(() => treeLaneFindings(outgoing)).toEqual([]);
              }
            },
          );
        }
      });
    }
    test.describe("spanning trigger", () => {
      test.use({ profile: "contract-visual-styles" });
      for (const root of [13, 20]) {
        test(
          `visual.tree-lanes.${zoom * 100}.trigger-span${
            root === 20 ? ".root20" : ""
          }`,
          { tag: ["@visual", "@isolated"] },
          async ({ isolatedState: state, page }) => {
            await page.goto(`${state.url}/?scene=uiconv&surface=trigger-span`);
            if (root === 20) {
              await page.addStyleTag({ content: ":root{font-size:20px}" });
            }
            const scope = page.getByRole("region", {
              name: "Tree trigger spans",
            });
            await expect(scope.getByRole("button", { name: "Child" }))
              .toHaveCount(2);
            await expect.poll(() => treeLaneFindings(scope)).toEqual([]);
          },
        );
      }
    });
  });
}
