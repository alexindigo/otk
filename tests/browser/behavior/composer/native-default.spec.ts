// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { messages, prompt, reply } from "../../pages/composer.ts";

test.use({ profile: "composer-native-default" });
test(
  "composer.unreported-default-omitted-at-wire-native-and-applied-honestly",
  { tag: ["@composer", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Unreported backend default",
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    await expect(page.locator(".otk-model-picker > button")).toContainText(
      "Backend default (not reported)",
    );
    await state.queue(["Native default applied."]);
    await prompt(page).fill("Use the backend default");
    await prompt(page).press("Enter");
    await reply(state, page, session.id, "Native default applied.");
    const frame = frames.sent.find(({ frame }) =>
      frame.method === "session.prompt"
    )!.frame.params!;
    expect(Object.hasOwn(frame, "model")).toBe(false);
    const bodies = (await state.observe<
      { transport: { bodies: Record<string, unknown>[] } }
    >()).transport.bodies;
    expect(bodies).toHaveLength(1);
    expect(Object.hasOwn(bodies[0], "model")).toBe(false);
    expect(
      (await messages(state, session.id)).find((row) =>
        row.info.role === "user"
      )!.info.model,
    ).toMatchObject({ providerID: "fake", modelID: "scripted" });
  },
);
