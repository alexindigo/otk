// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
import {
  type TaskMarkerGeometry,
  taskMarkerGeometry,
} from "../../../support/control-geometry.ts";
interface NativeBox {
  width: number;
  height: number;
  padding: number;
  right: number;
  parentRight: number;
  line: number;
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
  tasks: TaskMarkerGeometry[];
}
function checkboxGeometry(root: string) {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(`${root} input[type=checkbox]`),
  ).map((el) => {
    const label = el.closest("label")!,
      text = label.querySelector(".otk-control-label")!,
      r = el.getBoundingClientRect(),
      t = text.getBoundingClientRect(),
      p = label.getBoundingClientRect(),
      style = getComputedStyle(el);
    return {
      name: el.name,
      width: r.width,
      height: r.height,
      line: parseFloat(getComputedStyle(label).lineHeight),
      padding: parseFloat(style.paddingLeft),
      right: t.right,
      controlRight: r.right,
      parentRight: p.right,
      gap: t.left - r.right,
      centers: Math.abs(r.y + r.height / 2 - t.y - t.height / 2),
    };
  });
}
test(
  "visual.real-display-markdown-native-checkbox-select-and-settings-fields",
  { tag: ["@visual"] },
  async ({ state, page }, info) => {
    await state.product("prefs.set", { key: "theme", value: "otk-dark" });
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Control geometry",
    });
    await openSession(state, page, session.id);
    await state.queue(["- [ ] Unchecked task\n- [x] Checked task\n"]);
    await prompt(page, "Show task controls");
    await expect(page.locator(".otk-text li > .otk-task-marker"))
      .toHaveCount(2);
    await expect(page.locator(".otk-text li > input")).toHaveCount(0);
    const screenshot = info.outputPath("markdown-task-list-dark.png");
    await page.screenshot({
      path: screenshot,
      fullPage: true,
      animations: "disabled",
    });
    await info.attach("markdown-task-list-dark", {
      path: screenshot,
      contentType: "image/png",
    });
    for (const line of [24, 36]) {
      await page.locator(".otk-prose-task-item").evaluateAll((items, line) => {
        for (const item of items) {
          (item as HTMLElement).style.lineHeight = line + "px";
        }
      }, line);
      const markers = await page.evaluate<TaskMarkerGeometry[]>(
        `(${taskMarkerGeometry})()`,
      );
      await info.attach("markdown-marker-geometry-" + line, {
        body: JSON.stringify(markers),
        contentType: "application/json",
      });
      for (const marker of markers) {
        expect([marker.width, marker.height, marker.line]).toEqual([
          line,
          line,
          line,
        ]);
        for (const delta of marker.centres) {
          expect(delta).toBeLessThanOrEqual(.5);
        }
      }
    }
    await page.locator(".otk-prose-task-item").evaluateAll((items) => {
      for (const item of items) {
        (item as HTMLElement).style.removeProperty("line-height");
      }
    });
    await page.locator("textarea[name=prompt]").fill("Retain this draft");
    await page.locator(".otk-display-menu > button").click();
    await expect(page.locator(".otk-display-menu fieldset")).toBeEnabled();
    const g = await page.evaluate<NativeGeometry>(
      `(()=>{const controls=(${checkboxGeometry})('.otk-display-menu');return {controls:controls.map(c=>({...c,right:c.controlRight})),labels:controls,selects:[...document.querySelectorAll('.otk-display-menu .otk-select')].map(el=>{const trigger=el.querySelector('button'),r=trigger.getBoundingClientRect(),row=el.closest('.otk-preference-control'),t=row.querySelector(':scope > .otk-control-label').getBoundingClientRect(),p=row.getBoundingClientRect();return {padding:parseFloat(getComputedStyle(trigger).paddingLeft),right:r.right,parentRight:p.right,gap:r.left-t.right,centers:Math.abs(r.y+r.height/2-t.y-t.height/2),value:el.querySelector('input[type=hidden]').value};}),tasks:(${taskMarkerGeometry})()};})()`,
    );
    const display = await state.product("prefs.get", {});
    expect(display.diffStyle).toBe("auto");
    expect(g.controls.length).toBe(g.labels.length);
    expect(g.labels.length).toBeGreaterThan(0);
    for (const c of g.controls) {
      expect(c.width).toBeGreaterThan(0);
      expect(c.width).toBe(c.line);
      expect(c.height).toBeGreaterThan(0);
      expect(c.height).toBe(c.line);
      expect(c.padding).toBe(0);
      expect(c.right).toBeLessThanOrEqual(c.parentRight);
    }
    for (const l of g.labels) {
      expect(Math.abs(l.gap - 8)).toBeLessThanOrEqual(.05);
      expect(l.centers).toBeLessThanOrEqual(.5);
      expect(l.right).toBeLessThanOrEqual(l.parentRight + .5);
    }
    for (const s of g.selects) {
      expect(Math.abs(s.padding - 8)).toBeLessThan(.05);
      expect(Math.abs(s.gap - 8)).toBeLessThan(.05);
      expect(s.centers).toBeLessThanOrEqual(.5);
      expect(Math.abs(s.right - s.parentRight)).toBeLessThanOrEqual(.5);
    }
    // UX1 represents thinking as a positive expansion toggle, not a select.
    expect(g.selects.map((s: { value: string }) => s.value)).toEqual(["auto"]);
    await expect(page.locator("input[name=thinking]")).not.toBeChecked();
    // Rule 3 supersedes disabled Markdown checkbox controls with named status images.
    expect(g.tasks.map((t) => t.label)).toEqual(["Not done", "Done"]);
    for (const task of g.tasks) {
      expect([task.tag, task.role, task.controls, task.tabIndex]).toEqual([
        "SPAN",
        "img",
        0,
        null,
      ]);
      expect([task.width, task.height]).toEqual([task.line, task.line]);
      for (const delta of task.centres) expect(delta).toBeLessThanOrEqual(.5);
    }
    expect(g.tasks.map((task) => task.text)).toEqual([
      "Unchecked task",
      "Checked task",
    ]);
    // D21: clocks/actions are persistent, not a Display preference.
    await expect(page.locator("input[name=timestamps]")).toHaveCount(0);
    await page.locator("input[name=thinking]").click();
    await expect(page.locator("input[name=thinking]")).toBeChecked();
    await expect(page.locator("textarea[name=prompt]")).toHaveValue(
      "Retain this draft",
    );
    await page.keyboard.press("Escape");
    await expect(
      page.locator("[data-role=assistant] .otk-message-footer time[title]"),
    )
      .toBeVisible();
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
      `(${checkboxGeometry})('.otk-notification-settings')`,
    );
    expect(notification.map((c: { name: string }) => c.name)).toEqual([
      "notify.toast",
      "notify.os",
      "notify.sound",
      "notify.badge",
    ]);
    for (const c of notification) {
      expect(c.width).toBeGreaterThan(0);
      expect(c.width).toBe(c.line);
      expect(c.height).toBeGreaterThan(0);
      expect(c.height).toBe(c.line);
      expect(c.padding).toBe(0);
      expect(Math.abs(c.gap - 8)).toBeLessThanOrEqual(.05);
      expect(c.centers).toBeLessThanOrEqual(.5);
      expect(c.right).toBeLessThanOrEqual(c.parentRight + .5);
    }
  },
);
test(
  "visual.native-editor-blur-retains-more-anchor-and-independent-navigation",
  { tag: ["@visual"] },
  async ({ state, page }, info) => {
    const capture = async (stage: string) => {
      for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
        await state.product("prefs.set", { key: "theme", value: theme });
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await page.screenshot({
          path: info.outputPath(`more-${stage}-${theme}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
    };
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push(
        (await state.native<{ id: string }>("/session", "POST", {
          title: `Native ancestry session ${i} with a deliberately long title`,
          // D66: real undelivered helper runs drive the overflow inventory.
          ...(i ? { parentID: ids[i - 1] } : {}),
          // The meter assertion needs reported zero usage, not native defaults.
          ...(i === 4 && state.controller.info!.version.startsWith("2.")
            ? {
              messages: [{
                type: "assistant",
                agent: "build",
                model: { providerID: "fake", id: "scripted" },
                content: [],
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                time: { created: 1, completed: 2 },
              }],
            }
            : {}),
        })).id,
      );
    }
    // D67: a genuine held native run drives the composer inventory, while
    // ancestry remains available independently of execution/delivery state.
    const held = await state.queue(["Native helper result"], "held");
    await state.native(`/session/${ids[9]}/prompt_async`, "POST", {
      model: { providerID: "fake", modelID: "scripted" },
      parts: [{ type: "text", text: "Prepare helper result" }],
    });
    await state.product("tasks.create", {
      directory: state.directory,
      name: "Native folding",
      sessions: ids,
    });
    await page.goto(`${state.url}/#/local/${ids[4]}`);
    await expect(page.locator(".otk-breadcrumb-row")).toBeVisible();
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
    await page.locator(`[data-crumb="${ids[1]}"]`).click({
      button: "right",
    });
    await page.locator(
      '.otk-context-menu [data-context-command="session.rename"]',
    ).click();
    await expect(page.locator(".otk-title-editor input")).toBeFocused();
    const more = page.getByRole("button", { name: /^Subagents:/ });
    await expect(more).toHaveAccessibleName("Subagents: 1 running");
    await expect(more).toHaveAttribute("aria-expanded", "false");
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
    await capture("editing");
    const before = (await more.boundingBox())!;
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".otk-title-editor input")).toHaveCount(0);
    const afterBlur = (await more.boundingBox())!;
    for (const k of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(before[k] - afterBlur[k]),
        JSON.stringify({ before, afterBlur, axis: k }),
      ).toBeLessThanOrEqual(1);
    }
    await expect(
      page.locator(".otk-subagents [data-subagent]").first(),
    ).toBeVisible();
    const after = (await more.boundingBox())!;
    for (const k of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(before[k] - after[k]),
        JSON.stringify({ before, after, axis: k }),
      ).toBeLessThanOrEqual(1);
    }
    await capture("opened");
    await page.keyboard.press("ArrowDown");
    await expect(
      page.locator(".otk-subagents .otk-subagent-name:focus"),
    ).toHaveCount(1);
    await expect(page.locator(`[data-crumb="${ids[4]}"]`)).toBeVisible();
    const omitted = await page.locator(
      ".otk-subagents [data-subagent]",
    ).evaluateAll((els) => els.map((el) => el.getAttribute("data-subagent")!));
    expect(omitted.length).toBeGreaterThan(0);
    await page.locator(
      `.otk-subagents [data-subagent="${omitted[0]}"] .otk-subagent-name`,
    ).click();
    await expect(page).toHaveURL(new RegExp("/" + omitted[0] + "$"));
    await page.goto(state.url + "/#/local/" + ids[4]);
    await expect(page.locator(`[data-crumb="${ids[4]}"][aria-current=page]`))
      .toBeVisible();
    await state.product("session.abort", { sessionID: ids[9] });
    await state.release(held.gate);
  },
);
