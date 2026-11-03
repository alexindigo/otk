// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
import { labelTextBounds } from "../../../support/control-geometry.ts";
interface NativeBox {
  width: number;
  height: number;
  padding: number;
  right: number;
  parentRight: number;
}
interface LabelBox {
  gap: number;
  centers: number;
  right: number;
  parentRight: number;
}
interface SelectBox extends LabelBox {
  padding: number;
  value: string;
}
interface NativeGeometry {
  controls: NativeBox[];
  labels: LabelBox[];
  selects: SelectBox[];
  tasks: {
    checked: boolean;
    disabled: boolean;
    text: string;
    margin: number;
  }[];
}
test(
  "visual.real-display-markdown-native-checkbox-select-and-settings-fields",
  { tag: ["@visual"] },
  async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Control geometry",
    });
    await openSession(state, page, session.id);
    await state.queue(["- [ ] Unchecked task\n- [x] Checked task\n"]);
    await prompt(page, "Show task controls");
    await expect(page.locator(".otk-text li > input[type=checkbox]"))
      .toHaveCount(2);
    await page.locator("textarea[name=prompt]").fill("Retain this draft");
    await page.locator(".otk-display-menu > button").click();
    await expect(page.locator(".otk-display-menu fieldset")).toBeEnabled();
    const g = await page.evaluate<NativeGeometry>(
      `(()=>{const textBounds=${labelTextBounds};return {controls:[...document.querySelectorAll('.otk-display-menu input,.otk-text li > input')].map(el=>{const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return {width:r.width,height:r.height,padding:parseFloat(getComputedStyle(el).paddingLeft),right:r.right,parentRight:p.right};}),labels:[...document.querySelectorAll('.otk-display-menu input')].map(el=>{const r=el.getBoundingClientRect(),t=textBounds(el),p=el.parentElement.getBoundingClientRect();return {gap:t.left-r.right,centers:Math.abs(r.y+r.height/2-t.y-t.height/2),right:t.right,parentRight:p.right};}),selects:[...document.querySelectorAll('.otk-display-menu select')].map(el=>{const r=el.getBoundingClientRect(),t=textBounds(el),p=el.parentElement.getBoundingClientRect();return {padding:parseFloat(getComputedStyle(el).paddingLeft),right:r.right,parentRight:p.right,gap:r.left-t.right,centers:Math.abs(r.y+r.height/2-t.y-t.height/2),value:el.value};}),tasks:[...document.querySelectorAll('.otk-text li > input')].map(el=>({checked:el.checked,disabled:el.disabled,text:el.parentElement.textContent,margin:parseFloat(getComputedStyle(el).marginRight)}))};})()`,
    );
    const display = await state.product("prefs.get", {});
    expect(display.diffStyle).toBe("auto");
    expect(g.controls.length).toBe(g.labels.length + 2);
    expect(g.labels.length).toBeGreaterThan(0);
    for (const c of g.controls) {
      expect(c.width).toBeGreaterThan(0);
      expect(c.width).toBeLessThanOrEqual(18);
      expect(c.height).toBeGreaterThan(0);
      expect(c.height).toBeLessThanOrEqual(18);
      expect(c.padding).toBe(0);
      expect(c.right).toBeLessThanOrEqual(c.parentRight);
    }
    for (const l of g.labels) {
      expect(l.gap).toBeGreaterThanOrEqual(9.05);
      expect(l.gap).toBeLessThanOrEqual(15);
      expect(l.centers).toBeLessThanOrEqual(.5);
      expect(l.right).toBeLessThanOrEqual(l.parentRight + .5);
    }
    for (const s of g.selects) {
      expect(Math.abs(s.padding - 8)).toBeLessThan(.05);
      expect(Math.abs(s.gap - 8)).toBeLessThan(.05);
      expect(s.centers).toBeLessThanOrEqual(.5);
      expect(Math.abs(s.right - s.parentRight)).toBeLessThanOrEqual(.5);
    }
    expect(g.selects.map((s: { value: string }) => s.value)).toEqual([
      "hide",
      "auto",
    ]);
    expect(
      g.tasks.map((
        t: { checked: boolean; disabled: boolean; margin: number },
      ) => [t.checked, t.disabled, t.margin]),
    ).toEqual([[false, true, 8], [true, true, 8]]);
    expect(g.tasks[0].text).toContain("Unchecked task");
    expect(g.tasks[1].text).toContain("Checked task");
    await page.locator("input[name=timestamps]").click();
    await expect(page.locator("input[name=timestamps]")).toBeChecked();
    await expect(page.locator("textarea[name=prompt]")).toHaveValue(
      "Retain this draft",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.locator("input[name=command-search]").fill("Settings");
    await page.locator('[data-command="settings.open"]').click();
    await expect(page.locator(".otk-settings input[name=url]")).toBeVisible();
    const fields = await page.locator(
      ".otk-settings input",
    ).evaluateAll((els) =>
      els.filter((el) =>
        ["text", "url"].includes((el as HTMLInputElement).type)
      ).map((el) => ({
        name: (el as HTMLInputElement).name,
        width: el.getBoundingClientRect().width,
        parentWidth: el.parentElement!.getBoundingClientRect().width,
        padding: parseFloat(getComputedStyle(el).paddingLeft),
      }))
    );
    expect(fields.map((f) => f.name)).toEqual(["url", "label"]);
    for (const f of fields) {
      expect(f.width).toBe(f.parentWidth);
      expect(Math.abs(f.padding - 8)).toBeLessThan(.05);
    }
    const notification = await page.evaluate<
      (NativeBox & LabelBox & { name: string })[]
    >(
      `(()=>{const textBounds=${labelTextBounds};return [...document.querySelectorAll('.otk-notification-settings input[type=checkbox]')].map(el=>{const r=el.getBoundingClientRect(),s=textBounds(el),p=el.parentElement.getBoundingClientRect();return {name:el.name,width:r.width,height:r.height,padding:parseFloat(getComputedStyle(el).paddingLeft),gap:s.left-r.right,centers:Math.abs(r.y+r.height/2-s.y-s.height/2),right:s.right,parentRight:p.right};});})()`,
    );
    expect(notification.map((c: { name: string }) => c.name)).toEqual([
      "notify.toast",
      "notify.os",
      "notify.sound",
      "notify.badge",
    ]);
    for (const c of notification) {
      expect(c.width).toBeGreaterThan(0);
      expect(c.width).toBeLessThanOrEqual(18);
      expect(c.height).toBeGreaterThan(0);
      expect(c.height).toBeLessThanOrEqual(18);
      expect(c.padding).toBe(0);
      expect(c.gap).toBeGreaterThanOrEqual(9.7);
      expect(c.gap).toBeLessThanOrEqual(15);
      expect(c.centers).toBeLessThanOrEqual(.5);
      expect(c.right).toBeLessThanOrEqual(c.parentRight + .5);
    }
  },
);
test(
  "visual.native-editor-blur-retains-more-anchor-and-independent-navigation",
  { tag: ["@visual"] },
  async ({ state, page }) => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        (await state.native<{ id: string }>("/session", "POST", {
          title: `Native ${i}`,
        })).id,
      );
    }
    await state.product("tasks.create", {
      directory: state.directory,
      name: "Native folding",
      sessions: ids,
    });
    await openSession(state, page, ids[4]);
    // The neighboring meter owns a separate grid track. Its digest paint can
    // move More without changing the outer breadcrumb row's rectangle.
    await expect(page.locator(".otk-context-meter")).toHaveAttribute(
      "data-cost",
      "0",
    );
    await state.product("layout.patch", {
      leftCollapsed: true,
      rightCollapsed: true,
    });
    await page.setViewportSize({ width: 800, height: 800 });
    await page.locator(`[data-crumb="${ids[0]}"]`).click({ button: "right" });
    await page.locator(
      '.otk-context-menu [data-context-command="session.rename"]',
    ).click();
    await expect(page.locator(".otk-title-editor input")).toBeFocused();
    const more = page.locator(".otk-folded-crumbs > button");
    // Join font/layout settlement on the actual gesture target, after the
    // neighboring digest consumer has painted its authoritative value.
    await expect.poll(() =>
      more.evaluate(async (el) => {
        await document.fonts.ready;
        let r = el.getBoundingClientRect();
        for (let i = 0; i < 2; i++) {
          await new Promise(requestAnimationFrame);
          const next = el.getBoundingClientRect();
          if (
            r.x !== next.x || r.y !== next.y || r.width !== next.width ||
            r.height !== next.height
          ) return false;
          r = next;
        }
        return true;
      })
    ).toBe(true);
    const before = (await more.boundingBox())!;
    await more.click();
    await expect(
      page.locator(".otk-folded-crumbs [data-overflow-target]").first(),
    ).toBeVisible();
    const after = (await more.boundingBox())!;
    for (const k of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(before[k] - after[k]),
        JSON.stringify({ before, after, axis: k }),
      ).toBeLessThanOrEqual(1);
    }
    await page.keyboard.press("ArrowDown");
    await expect(
      page.locator(".otk-folded-crumbs [data-overflow-target]:focus"),
    ).toHaveCount(1);
    await expect(page.locator(`[data-crumb="${ids[4]}"]`)).toBeVisible();
    const omitted = await page.locator(
      ".otk-folded-crumbs [data-overflow-target]",
    ).evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-overflow-target")!)
    );
    expect(omitted.length).toBeGreaterThan(0);
    await page.locator(
      `.otk-folded-crumbs [data-overflow-target="${omitted[0]}"]`,
    ).click();
    await expect(page).toHaveURL(new RegExp("/" + omitted[0] + "$"));
    await page.goto(state.url + "/#/local/" + ids[4]);
    await expect(page.locator(`[data-crumb="${ids[4]}"][aria-current=page]`))
      .toBeVisible();
  },
);
