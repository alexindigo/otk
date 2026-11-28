// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import {
  expandTool,
  openLatestWork,
  prompt,
  revealAcquired,
  runNativeTool,
  scrollTranscript,
  sessionStatus,
  settledNativeReply,
  toolScript,
  workPanel,
} from "../../pages/transcript.ts";
test.describe("actual tool forms", () => {
  test.use({ profile: "messages-forms" });
  test("messages.native-work-log-omits-step-and-success-bookkeeping", {
    tag: ["@messages"],
  }, async ({ isolatedState: state, page }, info) => {
    await page.setViewportSize({ width: 1315, height: 1200 });
    await state.product("prefs.set", { key: "expandStepMarkers", value: true });
    await state.product("prefs.set", { key: "animationsOff", value: true });
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Work log review",
    });
    await openSession(state, page, session.id);
    await state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: [],
      tool: {
        name: "bash",
        input: { command: "pwd", description: "Find project directory" },
      },
    });
    const answer =
      "I found the project directory. The verification command exited with code 7.";
    await toolScript(
      state,
      "bash",
      {
        command: "exit 7",
        description: "Verify the test command",
      },
      answer,
    );
    await prompt(
      page,
      "Find the project directory and run the verification command.",
    );
    await settledNativeReply(state, session.id, answer);
    await scrollTranscript(page, true);
    await expect(page.locator(".otk-message-flow")).toContainText(
      "I found the project directory.",
    );
    await sessionStatus(page, session.id, "idle");
    await expect(page.locator(".otk-work-strip")).toContainText(
      "2 actions, 1 failed",
    );
    const work = await openLatestWork(page);
    await expect(work.locator("[data-tool=bash]")).toHaveCount(2);
    await expect(work.locator("[data-tool=bash].is-error").getByRole("alert"))
      .toContainText("Exited with code 7");
    await expect(page.locator(".otk-turn-usage > button")).toHaveText(
      /^3 model calls\b/,
    );
    await expect(page.locator(".otk-turn-time")).toHaveText(/^Worked for /);
    if (process.env.OTK_WORK_LOG_CAPTURES === "1") {
      for (
        const [name, theme] of [["dark", "otk-dark"], ["linen", "otk-light"], [
          "stone",
          "otk-light-stone",
        ]]
      ) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(0, 0);
        await page.screenshot({
          path: info.outputPath(`work-log-${name}.png`),
        });
      }
      console.info(
        "Work log rows:",
        await work.locator(
          ".otk-work-run :is([data-tool], [data-native-record])",
        ).count(),
      );
    }
    const body = work.locator(".otk-work-run");
    await expect(body).toHaveCount(2);
    for (const row of await body.all()) {
      await expect(row).not.toContainText(
        /Step started|Step finished|Execution succeeded/,
      );
    }
    await expect(
      body.locator(
        '[data-native-record=step], [data-native-record^="opencode-v1/step-"]',
      ),
    )
      .toHaveCount(0);
  });
  test("messages.native-failed-shell-visible-under-collapsed-defaults", {
    tag: ["@messages"],
  }, async ({ isolatedState: state, page }, info) => {
    await state.product("prefs.set", { key: "toolDetails", value: false });
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Visible failure",
    });
    await openSession(state, page, session.id);
    await toolScript(state, "bash", {
      command: "exit 7",
      description: "Expected failure",
    });
    await prompt(page, "Run the failing command");
    await expect(page.locator(".otk-message-flow")).toContainText(
      "Tool finished.",
    );
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await expect(
        page.locator(".otk-messages").getByRole("alert").filter({
          hasText: "Expected failure failed",
        }),
      ).toBeVisible();
      const work = await openLatestWork(page);
      const row = work.locator("[data-tool=bash]");
      await expect(row).toBeVisible();
      await expect(row.locator(".otk-tool-toggle")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await expect(row.locator(".otk-tool-toggle")).toContainText(
        "Expected failure",
      );
      await expect(row.getByRole("alert")).toContainText("Exited with code 7");
      await expect(row).toHaveClass(/is-error/);
      await expect(row.locator(".otk-tool-body")).toBeVisible();
    }
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await page.locator("[data-tool=bash] .otk-tool-toggle").focus();
      await page.screenshot({
        path: info.outputPath(`failure-${theme}.png`),
        fullPage: true,
      });
    }
  });
  test(
    "messages.bash-complete-output-cwd",
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
          (s) => s!.trimEnd().split("\n").length,
        )
      ).toBe(30);
      await expect(page.locator("[data-tool=bash]")).toContainText(
        "Running in",
      );
      await expect(page.locator("[data-tool=bash] .otk-output-toggle"))
        .toHaveCount(0);
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
      // Decisions 1/18 keep discovered instructions as a collapsed, inspectable record.
      await revealAcquired(
        page,
        '[data-native-record="opencode-v2/synthetic"]',
      );
      const instructions = page.locator(
        '[data-native-record="opencode-v2/synthetic"]',
      ).filter({ hasText: "Loaded src/AGENTS.md" });
      await expect(instructions).toBeVisible();
      const toggle = instructions.locator(".otk-tool-toggle");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      // A visible heading does not acquire the virtualized prose in its body.
      await revealAcquired(
        page,
        '[data-native-record="opencode-v2/synthetic"] .otk-tool-body',
      );
      await expect(instructions.locator(".otk-tool-body")).toContainText(
        "Instructions from: " + state.directory + "/src/AGENTS.md",
      );
      await expect(instructions.locator(".otk-tool-body")).toContainText(
        "Read the fixture only.",
      );
    } else {await expect(page.locator("[data-tool=read]")).toContainText(
        "Loaded src/AGENTS.md",
      );}
    await runNativeTool(state, page, s.id, "read", {
      filePath: state.directory + "/src",
    });
    await expandTool(page, "[data-tool=search]");
    const list = workPanel(page).locator("[data-tool=search]");
    await expect(list.locator(".otk-tool-toggle")).toHaveText(/^List\b/);
    await expect(
      list.filter({ has: page.locator("[data-search-mode=list]") })
        .locator(".otk-work-tool-summary"),
    ).toContainText("2 entries");
    for (const name of ["glob", "grep"]) {
      await runNativeTool(
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
      const selector = "[data-tool=search]";
      await expandTool(page, selector);
      const brief = workPanel(page).locator(
        `${selector}:has([data-search-mode=${name}]) .otk-work-tool-summary`,
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
    await expect(page.locator("input[name=genericToolOutput]")).toBeChecked();
    await page.keyboard.press("Escape");
    await expandTool(page, "[data-tool=external]");
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
      await openLatestWork(page);
      await expect(page.locator(`[data-tool=${name}].otk-tool-waiting`))
        .toBeAttached();
      await page.locator(".otk-permission-actions > button").nth(2).click();
      await expect(page.locator("textarea[name=rejection]")).toBeAttached();
      await page.locator(".otk-permission-dock button[type=submit]").click();
      await expect(page.locator(`[data-tool=${name}][data-tool-status=denied]`))
        .toBeAttached();
      await sessionStatus(page, s.id, "idle");
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
    await expect(page.locator(".otk-message-flow")).toContainText(
      "Missing file handled.",
    );
    const failedWork = await openLatestWork(page);
    await expect(failedWork.locator("[data-tool=read][data-tool-status=error]"))
      .toBeAttached();
    await sessionStatus(page, s.id, "idle");
    const failedRead = page.locator("[data-tool=read][data-tool-status=error]");
    await failedRead.getByRole("button", {
      name: "Details",
      exact: true,
    }).click();
    await expect(failedRead.getByRole("alert")).toContainText(
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
