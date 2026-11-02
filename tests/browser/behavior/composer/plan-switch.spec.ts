// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { messages, prompt, reply } from "../../pages/composer.ts";

test.use({ profile: "composer-plan" });
test(
  "composer.native-plan-approval-next-selection-and-plugin-name-nontransition",
  { tag: ["@composer", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    test.setTimeout(120_000);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Plan/build switch",
    });
    const other = await state.native<{ id: string }>("/session", "POST", {
      title: "Other session",
    });
    const frames = await wire(page);
    const footer = async (agent: string, variant: string) => {
      await expect(page.locator(".otk-composer-agent")).toHaveText(
        agent === "plan" ? "Plan" : "Build",
      );
      await expect(page.locator(".otk-variant-picker > button > span"))
        .toHaveText(variant === "low" ? "Low" : "High");
    };
    const pick = async (agent: string) => {
      await page.locator(".otk-agent-picker > button").click();
      await page.locator(
        `.otk-agent-picker [data-picker-key="${agent}"] .otk-picker-option`,
      ).click();
    };
    const queue = async (chunks: string[], tool?: string) => {
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        target: "selected",
        chunks: tool ? [] : chunks,
        ...(tool ? { tool: { name: tool, input: {} } } : {}),
      });
      if (tool && chunks.length) {
        await state.controller.call("queueScript", {
          lease: state.lease.lease,
          target: "selected",
          chunks,
        });
      }
    };
    const send = async (text: string) => {
      await prompt(page).fill(text);
      await page.locator(".otk-prompt button[type=submit]").click();
    };
    const nativeUser = async (text: string, agent: string, variant: string) => {
      await expect.poll(async () =>
        (await messages(state, session.id)).find((row) =>
          row.info.role === "user" &&
          row.parts.some((p) => p.type === "text" && p.text === text)
        )?.info
      ).toMatchObject({
        agent,
        model: { providerID: "fake2", modelID: "scripted", variant },
      });
      const frame = frames.sent.find(({ frame }) =>
        frame.method === "session.prompt" &&
        (frame.params!.parts as { text?: string }[]).some((p) =>
          p.text === text
        )
      )!.frame.params!;
      expect({ agent: frame.agent, model: frame.model, variant: frame.variant })
        .toEqual({
          agent,
          model: { provider: "fake2", model: "scripted" },
          variant,
        });
    };
    const answer = async (index: number) => {
      await page.locator(".otk-question-options [data-question-row]").nth(index)
        .click();
      await page.locator(".otk-question-actions .otk-primary").click();
      await expect(page.locator(".otk-question-dock dl")).toBeVisible();
      await page.locator(".otk-question-actions .otk-primary").click();
    };
    await openSession(state, page, session.id);
    await pick("plan");
    await footer("plan", "low");
    await queue(["Plan approved."], "plan_exit");
    await send("P5 finish planning");
    await expect(page.locator(".otk-question-dock .otk-question-options"))
      .toBeVisible();
    await footer("plan", "low");
    await answer(0);
    await expect.poll(async () =>
      (await messages(state, session.id)).some((row) =>
        row.parts.some((part) =>
          part.tool === "plan_exit" && part.state?.status === "completed"
        )
      )
    ).toBe(true);
    await reply(state, page, session.id, "Plan approved.");
    await footer("build", "high");
    await nativeUser("P5 finish planning", "plan", "low");
    await queue(["Planning entered."], "plan_enter");
    await send("P5 reconsider the implementation");
    await expect.poll(async () =>
      (await messages(state, session.id)).some((row) =>
        row.parts.some((part) =>
          part.tool === "plan_enter" && part.state?.status === "completed"
        )
      )
    ).toBe(true);
    await reply(state, page, session.id, "Planning entered.");
    await footer("build", "high");
    await nativeUser("P5 reconsider the implementation", "build", "high");
    await pick("plan");
    await footer("plan", "low");
    await queue(["Next plan prompt received."]);
    await send("P5 continue in plan");
    await reply(state, page, session.id, "Next plan prompt received.");
    await nativeUser("P5 continue in plan", "plan", "low");
    await queue([], "plan_exit");
    await send("P5 keep refining the plan");
    await expect(page.locator(".otk-question-dock .otk-question-options"))
      .toBeVisible();
    await answer(1);
    await expect(page.locator("[data-tool-status=denied]")).toBeVisible();
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
    await footer("plan", "low");
    await nativeUser("P5 keep refining the plan", "plan", "low");
    const observation = await state.observe<
      {
        requests: unknown[];
        selectedRequests: {
          tools?: { function: { name: string } }[];
          reasoning_effort?: string;
        }[];
      }
    >();
    expect(observation.requests).toHaveLength(0);
    expect(
      observation.selectedRequests.some((request) =>
        request.tools?.some((tool) => tool.function.name === "plan_enter")
      ),
    ).toBe(true);
    expect(
      observation.selectedRequests.some((request) =>
        request.reasoning_effort === "low"
      ),
    ).toBe(true);
    expect(
      observation.selectedRequests.some((request) =>
        request.reasoning_effort === "high"
      ),
    ).toBe(true);
    await pick("build");
    await footer("build", "high");
    await openSession(state, page, other.id);
    await openSession(state, page, session.id);
    await footer("build", "high");
    await page.reload();
    await openSession(state, page, session.id);
    await footer("plan", "low");
  },
);
