// SPDX-License-Identifier: LGPL-3.0-only
import type { Page } from "@playwright/test";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { expandTool, prompt, runNativeTool } from "../../pages/transcript.ts";
import { independentPage } from "../../pages/visual.ts";
test.use({ profile: "isolated" });
const tags = { tag: ["@visual", "@isolated"] };
async function openTheme(page: Page) {
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Commands", exact: true }))
    .toBeVisible();
  await page.locator("input[name=command-search]").fill("Choose theme");
  await page.locator('[data-command="theme.open"]').click();
  await expect(page.getByRole("dialog", { name: "Theme", exact: true }))
    .toBeVisible();
}
async function choose(page: Page, id: string) {
  await page.locator(`[data-theme-choice="${id}"]`).click();
  await expect(page.locator("html")).toHaveAttribute("data-otk-theme", id);
}
async function painted(page: Page, id: string, bg: string) {
  await expect(page.locator("html")).toHaveAttribute("data-otk-theme", id);
  await expect.poll(() =>
    page.locator("html").evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--otk-bg")
    )
  ).toBe(bg);
}
test(
  "visual.unknown-theme-fallback-keeps-persisted-identity",
  tags,
  async ({ isolatedState: state, page, browser }) => {
    await state.product("prefs.set", {
      key: "theme",
      value: "plugin:uninstalled",
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(state.url);
    const { page: other, errors } = await independentPage(state, browser);
    await other.goto(state.url);
    for (const p of [page, other]) {
      await painted(p, "plugin:uninstalled", "#1a1c1e");
      expect(
        await p.locator("html").evaluate((el) =>
          getComputedStyle(el).colorScheme
        ),
      ).toBe("dark");
      await expect(p.locator('meta[name="theme-color"]')).toHaveAttribute(
        "content",
        "#1a1c1e",
      );
    }
    await expect(
      state.product("prefs.set", { key: "theme", value: "invalid theme" }),
    ).rejects.toThrow();
    expect((await state.product("prefs.get", {})).theme).toBe(
      "plugin:uninstalled",
    );
    await page.reload();
    await painted(page, "plugin:uninstalled", "#1a1c1e");
    await state.product("prefs.set", { key: "theme", value: "otk-light" });
    for (const p of [page, other]) await painted(p, "otk-light", "#f4eee3");
    expect(errors).toEqual([]);
  },
);
test(
  "visual.system-light-picker-broadcast-reload-os-and-unavailable-identities",
  tags,
  async ({ isolatedState: state, page, browser }) => {
    const { page: other, errors } = await independentPage(state, browser);
    for (const p of [page, other]) {
      await p.emulateMedia({ colorScheme: "light" });
      await p.goto(state.url);
    }
    await openTheme(page);
    await expect(page.locator("select[name=systemLightTheme]")).toHaveValue(
      "otk-light",
    );
    await choose(page, "system");
    await page.getByRole("button", { name: "Save theme", exact: true }).click();
    await painted(other, "system", "#f4eee3");
    await openTheme(page);
    await page.locator("select[name=systemLightTheme]").selectOption(
      "otk-light-stone",
    );
    for (const p of [page, other]) await painted(p, "system", "#f5f3ef");
    expect((await state.product("prefs.get", {})).systemLightTheme).toBe(
      "otk-light-stone",
    );
    await page.keyboard.press("Escape");
    await page.reload();
    await painted(page, "system", "#f5f3ef");
    await page.emulateMedia({ colorScheme: "dark" });
    await painted(page, "system", "#1a1c1e");
    await page.emulateMedia({ colorScheme: "light" });
    await painted(page, "system", "#f5f3ef");
    for (const id of ["plugin:uninstalled-light", "otk-dark"]) {
      await state.product("prefs.set", { key: "systemLightTheme", value: id });
      for (const p of [page, other]) await painted(p, "system", "#f4eee3");
      expect((await state.product("prefs.get", {})).systemLightTheme).toBe(id);
    }
    await expect(
      state.product("prefs.set", {
        key: "systemLightTheme",
        value: "invalid theme",
      }),
    ).rejects.toThrow();
    expect(errors).toEqual([]);
  },
);
test(
  "visual.theme-save-rejection-retains-preview-and-committed-state",
  tags,
  async ({ isolatedState: state, page }) => {
    await wire(
      page,
      (frame) =>
        frame.t === "request" && frame.method === "prefs.set" &&
          frame.params?.key === "theme"
          ? {
            ...frame,
            params: { ...frame.params, value: "invalid theme identity" },
          }
          : frame,
    );
    await page.goto(state.url);
    await expect(page.locator(".otk-sidebar-commands")).toBeAttached();
    await openTheme(page);
    await choose(page, "otk-light");
    await page.getByRole("button", { name: "Save theme", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Theme", exact: true }).getByRole(
        "alert",
      ),
    ).toContainText("failed for");
    await expect(page.getByRole("button", { name: "Save theme", exact: true }))
      .toBeEnabled();
    await expect(page.locator('.otk-toast[data-kind="error"]')).toHaveCount(0);
    await painted(page, "otk-light", "#f4eee3");
    await page.locator(".otk-theme-actions button").first().click();
    await expect(page.getByRole("dialog", { name: "Theme", exact: true }))
      .toHaveCount(0);
    await painted(page, "otk-dark", "#1a1c1e");
    await page.reload();
    await painted(page, "otk-dark", "#1a1c1e");
    expect((await state.product("prefs.get", {})).theme).toBe("otk-dark");
  },
);
test(
  "visual.real-code-diff-theme-preview-cancel-concurrent-save-and-system-without-worker-work",
  tags,
  async ({ isolatedState: state, page, browser }, info) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1600, height: 1200 });
    await page.emulateMedia({ colorScheme: "dark" });
    // External worker observation preserves the real worker; settled highlights are
    // the readiness boundary, rather than the legacy 200ms quiet-window guess.
    await page.addInitScript(
      `(()=>{globalThis.themeWorkerEvidence={created:0,sent:0,received:0,terminated:0};const Native=Worker;globalThis.Worker=class extends Native{constructor(...args){super(...args);themeWorkerEvidence.created++;this.addEventListener('message',()=>themeWorkerEvidence.received++);}postMessage(...args){themeWorkerEvidence.sent++;return super.postMessage(...args);}terminate(){themeWorkerEvidence.terminated++;return super.terminate();}};})()`,
    );
    await state.controller.call("writeProjectFiles", {
      lease: state.lease.lease,
      files: { "theme.ts": "const oldPaint = 1;\n" },
    });
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Theme consumers",
    });
    const traffic = await wire(page);
    await openSession(state, page, session.id);
    await runNativeTool(state, page, session.id, "edit", {
      filePath: state.directory + "/theme.ts",
      oldString: "oldPaint",
      newString: "newPaint",
    });
    await expandTool(page, "[data-tool=edit]");
    await state.queue([
      "Theme consumer text.\n\n```ts\n// Theme comment\nconst orange: number = 7;\nfunction run(name: string) { return name + orange; }\n```\n",
    ]);
    await prompt(page, "Show existing code and diff consumers");
    await expect(
      page.locator(".otk-code .otk-token").filter({ hasText: "Theme comment" }),
    ).toBeAttached();
    await expect(page.locator(".otk-tool-add")).toBeAttached();
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
    const paint = () =>
      page.evaluate(
        `(()=>{const root=document.documentElement,css=getComputedStyle(root);return {id:root.dataset.otkTheme,bg:css.getPropertyValue('--otk-bg'),scheme:css.colorScheme,meta:document.querySelector('meta[name="theme-color"]').content,text:getComputedStyle(document.querySelector('.otk-text')).color,code:[...document.querySelectorAll('.otk-code .otk-token')].map(el=>({text:el.textContent,color:getComputedStyle(el).color,style:el.getAttribute('style')})),add:getComputedStyle(document.querySelector('.otk-tool-add')).color,del:getComputedStyle(document.querySelector('.otk-tool-del')).color,wordmark:getComputedStyle(document.querySelector('.otk-inbox-brand strong')).color,work:themeWorkerEvidence};})()`,
      ) as Promise<Record<string, unknown>>;
    await page.locator("textarea[name=prompt]").fill("Preserve this draft");
    const dark = await paint();
    expect(dark.bg).toBe("#1a1c1e");
    expect(dark.scheme).toBe("dark");
    expect(dark.meta).toBe(dark.bg);
    expect(dark.wordmark).toBe("rgb(230, 234, 239)");
    const tokens = await page.locator(".otk-code .otk-token").elementHandles(),
      writes =
        traffic.sent.filter(({ frame }) => frame.method === "prefs.set").length;
    await openTheme(page);
    await choose(page, "otk-light");
    const light = await paint();
    expect(light.bg).toBe("#f4eee3");
    expect(light.scheme).toBe("light");
    expect(light.meta).toBe(light.bg);
    expect(light.wordmark).toBe("rgb(42, 36, 28)");
    for (const field of ["text", "code", "add", "del"]) {
      expect(light[field]).not.toEqual(dark[field]);
    }
    expect(light.work).toEqual(dark.work);
    for (let i = 0; i < tokens.length; i++) {
      expect(
        await page.locator(".otk-code .otk-token").nth(i).evaluate(
          (el, old) => el === old,
          tokens[i],
        ),
      ).toBe(true);
    }
    const styles = (x: Record<string, unknown>) =>
      (x.code as { style: string }[]).map((t) => t.style);
    expect(styles(light)).toEqual(styles(dark));
    expect(traffic.sent.filter(({ frame }) => frame.method === "prefs.set"))
      .toHaveLength(writes);
    await page.locator(".otk-theme-actions button").first().click();
    await painted(page, "otk-dark", "#1a1c1e");
    expect(await paint()).toEqual(dark);
    await openTheme(page);
    await choose(page, "otk-light");
    await page.keyboard.press("Escape");
    await painted(page, "otk-dark", "#1a1c1e");
    await expect(page.locator("textarea[name=prompt]")).toHaveValue(
      "Preserve this draft",
    );
    const { page: other, errors } = await independentPage(state, browser);
    await other.emulateMedia({ colorScheme: "dark" });
    await openSession(state, other, session.id);
    await openTheme(page);
    await choose(page, "otk-light");
    await openTheme(other);
    await choose(other, "system");
    await other.getByRole("button", { name: "Save theme", exact: true })
      .click();
    await painted(page, "otk-light", "#f4eee3");
    await page.keyboard.press("Escape");
    await painted(page, "system", "#1a1c1e");
    await openTheme(page);
    await choose(page, "otk-light");
    await page.getByRole("button", { name: "Save theme", exact: true }).click();
    for (const p of [page, other]) await painted(p, "otk-light", "#f4eee3");
    await page.reload();
    await painted(page, "otk-light", "#f4eee3");
    await expect(page.locator(".otk-code .otk-token").first()).toBeAttached();
    // Decision 18: reload restores collapsed defaults; reopen as a user would.
    await expandTool(page, "[data-tool=edit]");
    expect((await paint()).code).toEqual(light.code);
    await openTheme(page);
    await choose(page, "system");
    await page.getByRole("button", { name: "Save theme", exact: true }).click();
    await painted(other, "system", "#1a1c1e");
    const before = await paint();
    await page.emulateMedia({ colorScheme: "light" });
    await painted(page, "system", "#f4eee3");
    const systemLight = await paint();
    expect(systemLight.code).toEqual(light.code);
    expect(systemLight.work).toEqual(before.work);
    expect(systemLight.meta).toBe(light.bg);
    await page.emulateMedia({ colorScheme: "dark" });
    await painted(page, "system", "#1a1c1e");
    const systemDark = await paint();
    expect(systemDark.code).toEqual(dark.code);
    expect(systemDark.work).toEqual(before.work);
    expect(errors).toEqual([]);
    await info.attach("theme-consumers", {
      body: JSON.stringify({ dark, light, systemLight, systemDark }),
      contentType: "application/json",
    });
  },
);
