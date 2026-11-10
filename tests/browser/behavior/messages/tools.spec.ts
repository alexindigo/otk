// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { expandTool, prompt, runNativeTool } from "../../pages/transcript.ts";
test.describe("actual tool forms", () => {
  test.use({ profile: "messages-forms" });
  test(
    "messages.bash-ten-thirty-cwd",
    { tag: ["@messages"] },
    async ({ isolatedState: state, page }) => {
      await state.controller.call("writeProjectFiles", {
        lease: state.lease.lease,
        files: { "sub/.keep": "" },
      });
      const s = await state.native<{ id: string }>("/session", "POST", {
        title: "Bash rendering",
      });
      await openSession(state, page, s.id);
      const raw = await runNativeTool(state, page, s.id, "bash", {
        command: "seq 1 30",
        description: "Thirty lines",
        workdir: state.directory + "/sub",
      });
      expect(raw.state.output).toBeTruthy();
      await expandTool(page, "[data-tool=bash]");
      await expect.poll(() =>
        page.locator("[data-tool=bash] .otk-tool-output").textContent().then(
          (s) => s!.split("\n").length,
        )
      ).toBe(10);
      await expect(page.locator("[data-tool=bash]")).toContainText(
        "Running in",
      );
      await page.locator("[data-tool=bash] .otk-output-toggle").click();
      await expect.poll(() =>
        page.locator("[data-tool=bash] .otk-tool-output").textContent().then(
          (s) => s!.split("\n").length,
        )
      ).toBe(30);
    },
  );
  test("messages.native-read-search-fetch-skill-generic-forms", {
    tag: ["@messages"],
  }, async ({ isolatedState: state, page }) => {
    const s = await state.native<{ id: string }>("/session", "POST", {
      title: "Tool forms",
    });
    await openSession(state, page, s.id);
    await runNativeTool(state, page, s.id, "read", {
      filePath: state.directory + "/src/probe.txt",
      offset: 2,
      limit: 1,
    });
    await expandTool(page, "[data-tool=read]");
    if (state.controller.info!.version.startsWith("2.")) {
      // V2 publishes discovered instructions as their own durable synthetic message.
      await expect(page.locator(".otk-message-flow")).toContainText(
        "Instructions from: " + state.directory + "/src/AGENTS.md",
      );
      await expect(page.locator(".otk-message-flow")).toContainText(
        "Read the fixture only.",
      );
    } else {await expect(page.locator("[data-tool=read]")).toContainText(
        "↳ Loaded",
      );}
    await runNativeTool(state, page, s.id, "read", {
      filePath: state.directory + "/src",
    });
    await expandTool(
      page,
      '[data-tool=search]:has(.otk-tool-verb[title="List"])',
    );
    await expect(
      page.locator(
        ".otk-tool-line:has([data-search-mode=list]) .otk-tool-brief",
      ),
    ).toContainText("2 entries");
    for (const name of ["glob", "grep"]) {
      const raw = await runNativeTool(
        state,
        page,
        s.id,
        name,
        name === "glob"
          ? { pattern: "*.txt", path: state.directory + "/src" }
          : {
            pattern: "otk_marker",
            path: state.directory + "/src",
            include: "*.txt",
          },
      );
      const selector = `[data-message="${raw.messageID}"] .otk-tool-line`;
      await expandTool(page, selector);
      const brief = page.locator(
        `.otk-tool-line:has([data-search-mode=${name}]) .otk-tool-brief`,
      );
      await expect(brief).toContainText("1 match");
      await expect(brief).not.toContainText("1 matches");
    }
    const url = state.controller.info!.nativeUrl + "/global/health";
    await runNativeTool(state, page, s.id, "webfetch", { url, format: "text" });
    await expect(page.locator("[data-tool=fetch]")).toContainText(url);
    await runNativeTool(state, page, s.id, "skill", { name: "otk-fixture" });
    await expect(page.locator("[data-tool=skill]")).toContainText(
      "otk-fixture",
    );
    await runNativeTool(state, page, s.id, "echo_fixture", {});
    await page.locator(".otk-display-menu > button").click();
    await page.locator("input[name=genericToolOutput]").click();
    await expect(page.locator("input[name=genericToolOutput]")).toBeChecked();
    await page.keyboard.press("Escape");
    await expandTool(page, "[data-tool=external]");
    await expect(page.locator("[data-tool=external] .otk-tool-output"))
      .toHaveJSProperty(
        "textContent",
        Array.from({ length: 10 }, (_, i) => `Generic line ${i + 1}`).join(
          "\n",
        ),
      );
    await page.locator("[data-tool=external] .otk-output-toggle").click();
    await expect(page.locator("[data-tool=external] .otk-tool-output"))
      .toHaveJSProperty(
        "textContent",
        Array.from({ length: 15 }, (_, i) => `Generic line ${i + 1}`).join(
          "\n",
        ),
      );
  });
});
test.describe("tool permission/error states", () => {
  test.use({ profile: "messages-tool-states" });
  test("messages.permission-denial-error-state-contract", {
    tag: ["@messages"],
  }, async ({ isolatedState: state, page }) => {
    const s = await state.native<{ id: string }>("/session", "POST", {
      title: "Tool states",
    });
    await openSession(state, page, s.id);
    for (const name of ["bash", "websearch"]) {
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        chunks: [],
        tool: {
          name,
          input: name === "bash"
            ? { command: "echo denied", description: "Denied" }
            : { query: "OTK rendering fixture", numResults: 8 },
        },
      });
      await prompt(
        page,
        name === "bash" ? "Ask permission" : "Ask web search permission",
      );
      await expect(page.locator(`[data-tool=${name}].otk-tool-waiting`))
        .toBeAttached();
      await page.locator(".otk-permission-actions > button").nth(2).click();
      await expect(page.locator("textarea[name=rejection]")).toBeAttached();
      await page.locator(".otk-permission-dock button[type=submit]").click();
      await expect(page.locator(`[data-tool=${name}][data-tool-status=denied]`))
        .toBeAttached();
      await expect(page.locator(`[data-session="${s.id}"]`)).toHaveAttribute(
        "data-status",
        "idle",
      );
    }
    await expect(page.locator("[data-tool=websearch]")).not.toContainText(
      "count unavailable",
    );
    await state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: [],
      tool: {
        name: "read",
        input: { filePath: state.directory + "/missing.txt" },
      },
    });
    await state.queue(["Missing file handled."]);
    await prompt(page, "Show a tool error");
    await expect(page.locator("[data-tool=read][data-tool-status=error]"))
      .toBeAttached();
    await expect(page.locator(".otk-message-flow")).toContainText(
      "Missing file handled.",
    );
    await expect(page.locator(`[data-session="${s.id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
    await page.locator("[data-tool=read] .otk-tool-error-toggle").click();
    await expect(page.locator(".otk-tool-error")).toContainText(
      "File not found",
    );
    await expect.poll(async () => {
      const raw = await state.native<
        { parts: { tool?: string; state?: { status: string } }[] }[]
      >(`/session/${s.id}/message`);
      return raw.some((m) =>
        m.parts.some((p) => p.tool === "read" && p.state?.status === "error")
      );
    }).toBe(true);
  });
});
