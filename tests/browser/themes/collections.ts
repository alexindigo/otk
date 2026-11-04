// SPDX-License-Identifier: LGPL-3.0-only
import type { CDPSession, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import type { wire } from "../fixtures/wire.ts";
import { promptFooterControls } from "../../support/prompt-footer.ts";
import { selectionGeometry } from "../../support/selection-geometry.ts";
import { fixedContent } from "./content.ts";
import { accessoryGeometry } from "../../support/control-geometry.ts";

interface Theme {
  id: string;
}
interface Inputs {
  state: TestState;
  page: Page;
  cdp: CDPSession;
  themes: Theme[];
  native: { url: string; emptyID: string };
  content: { sessionID: string };
  scenes: string;
  traffic: Awaited<ReturnType<typeof wire>>;
  paint(theme: Theme): Promise<void>;
  shot(name: string): Promise<void>;
}
async function frames(page: Page) {
  await page.evaluate(() =>
    document.fonts.ready.then(() =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    )
  );
}
/** Reveal through reader scroll intents, including source outside the live range. */
export async function reveal(page: Page, selector: string) {
  const pane = page.locator(".otk-messages");
  const wheel = async (deltaY: number) => {
    if (Math.abs(deltaY) < 1) return;
    const p = await pane.boundingBox();
    await page.mouse.move(p!.x + p!.width / 2, p!.y + p!.height / 2);
    await page.evaluate(() => {
      const el = document.querySelector(".otk-messages")!;
      el.setAttribute("data-theme-scroll", "pending");
      el.addEventListener(
        "scrollend",
        () => el.setAttribute("data-theme-scroll", "settled"),
        { once: true },
      );
    });
    await page.mouse.wheel(0, deltaY);
    await expect(pane).toHaveAttribute("data-theme-scroll", "settled");
    await frames(page);
  };
  const measure = () =>
    pane.evaluate((el, selector) => {
      const target = el.querySelector(selector),
        a = el.getBoundingClientRect(),
        b = target?.getBoundingClientRect();
      return {
        top: el.scrollTop,
        end: el.scrollHeight - el.clientHeight,
        height: el.clientHeight,
        delta: b
          ? b.top >= a.top && b.bottom <= a.bottom
            ? 0
            : b.top + Math.min(b.height, el.clientHeight) / 2 - a.top -
              el.clientHeight / 2
          : null,
      };
    }, selector);
  await frames(page);
  let g = await measure();
  if (g.delta === null && g.top > 0) {
    await wheel(-g.end);
    g = await measure();
  }
  while (g.delta === null) {
    expect(g.top, `Acquired source unavailable: ${selector}`).toBeLessThan(
      g.end,
    );
    await wheel(Math.min(g.height, g.end - g.top));
    g = await measure();
  }
  if (g.delta !== 0) {
    await wheel(Math.max(-g.top, Math.min(g.delta, g.end - g.top)));
  }
}
export async function composerAccessories(
  page: Page,
  theme: Theme,
  shot: Inputs["shot"],
) {
  // Every width scene owns its layout independently of preceding full panels.
  if (
    await page.locator(".otk-project-inbox").getAttribute("data-collapsed") ===
      "false"
  ) await page.locator(".otk-corner-left").click();
  if (await page.locator(".otk-right-panel").isVisible()) {
    await page.locator(".otk-corner-right").click();
  }
  await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await expect(page.locator(".otk-right-panel")).not.toBeVisible();
  for (const width of [600, 800, 1280, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const mode of ["normal", "focus", "hover"]) {
      const control = page.locator(".otk-control-trigger").first();
      if (mode === "focus") await control.focus();
      if (mode === "hover") await control.hover();
      await frames(page);
      const values = await page.evaluate(accessoryGeometry) as {
        icon: number[];
        gaps: number[];
      }[];
      expect(values.length).toBeGreaterThanOrEqual(2);
      for (const value of values) {
        expect(value.icon).toEqual([16, 16]);
        expect(Math.max(...value.gaps) - Math.min(...value.gaps))
          .toBeLessThanOrEqual(1);
      }
    }
    await shot(`composer-accessories-${theme.id}-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 657 });
  await page.locator(".otk-corner-left").click();
  await page.locator(".otk-corner-right").click();
  await expect(page.locator(".otk-right-panel")).toBeVisible();
}
export async function loadedImage(
  { state, page, sessionID, nativePage, theme, image, shot }: {
    state: TestState;
    page: Page;
    sessionID: string;
    nativePage(id: string): Promise<void>;
    theme: Theme;
    image: string;
    shot: Inputs["shot"];
  },
) {
  const filename = `sample-${theme.id}.png`;
  await state.native(`/session/${sessionID}/message`, "POST", {
    noReply: true,
    parts: [{ type: "text", text: "Describe these shapes." }, {
      type: "file",
      filename,
      mime: "image/png",
      url: image,
    }],
  });
  await nativePage(sessionID);
  const trigger = page.getByRole("button", {
    name: `Open image: ${filename}`,
    exact: true,
  });
  await expect.poll(() =>
    trigger.locator("img").evaluate((el) =>
      (el as HTMLImageElement).naturalWidth
    )
  ).toBe(640);
  expect(await trigger.locator("img").getAttribute("src")).toBe(image);
  await trigger.click();
  const view = page.locator("dialog[open] img");
  await expect.poll(() =>
    view.evaluate((el) => (el as HTMLImageElement).naturalWidth)
  ).toBe(640);
  expect(await view.getAttribute("src")).toBe(image);
  expect(
    await view.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return Math.abs(r.width / r.height - 1.6);
    }),
  ).toBeLessThan(.01);
  expect((await view.boundingBox())!.width).toBeGreaterThan(
    (await trigger.locator("img").boundingBox())!.width,
  );
  await expect(page.locator("dialog[open] h2")).toHaveCount(1);
  await expect(page.locator("dialog[open] h2")).toHaveText(filename);
  await shot(`composer-image-dialog-${theme.id}-1280`);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
}
async function token(page: Page, name: string) {
  return await page.evaluate((name) => {
    const el = document.createElement("span");
    el.style.position = "fixed";
    el.style.visibility = "hidden";
    el.style.color = `var(${name})`;
    document.body.append(el);
    const value = getComputedStyle(el).color;
    el.remove();
    return value;
  }, name);
}
async function nativeInput(page: Page) {
  await frames(page);
  return await page.locator("textarea[name=prompt]").evaluate((el) => {
    const t = el as HTMLTextAreaElement,
      s = getComputedStyle(t),
      r = t.getBoundingClientRect(),
      footer = document.querySelector(".otk-prompt-actions")!
        .getBoundingClientRect(),
      composer = document.querySelector(".otk-composer")!
        .getBoundingClientRect(),
      mirror = document.createElement("div"),
      caret = document.createElement("span");
    Object.assign(mirror.style, {
      position: "fixed",
      left: "0",
      top: "0",
      visibility: "hidden",
      pointerEvents: "none",
      width: r.width + "px",
      font: s.font,
      letterSpacing: s.letterSpacing,
      whiteSpace: "pre-wrap",
      overflowWrap: s.overflowWrap,
      wordBreak: s.wordBreak,
    });
    mirror.textContent = t.value.slice(0, t.selectionEnd);
    caret.textContent = String.fromCharCode(0x200b);
    mirror.append(caret);
    document.body.append(mirror);
    const m = mirror.getBoundingClientRect(), c = caret.getBoundingClientRect();
    const during = t.getBoundingClientRect();
    if (
      [r.x, r.y, r.width, r.height].some((value, i) =>
        value !== [during.x, during.y, during.width, during.height][i]
      )
    ) throw new Error("Caret probe changed native input geometry");
    const caretTop = c.top - m.top - t.scrollTop,
      caretBottom = c.bottom - m.top - t.scrollTop;
    mirror.remove();
    const result = {
      height: t.clientHeight,
      scrollHeight: t.scrollHeight,
      scrollTop: t.scrollTop,
      caretTop,
      caretBottom,
      line: s.lineHeight,
      resize: s.resize,
      bottom: composer.bottom,
      top: composer.top,
      footer: [footer.top, footer.bottom],
      inputBottom: r.bottom,
      viewport: innerHeight,
      transcriptBottom:
        document.querySelector(".otk-messages")!.getBoundingClientRect().bottom,
      scroll: [
        document.querySelector(".otk-composer")!.scrollTop,
        document.scrollingElement!.scrollTop,
      ],
    };
    return result;
  });
}
async function footer(page: Page, count: number) {
  await expect(page.locator(promptFooterControls)).toHaveCount(count);
  await frames(page);
  const g = await page.locator(".otk-prompt-actions").evaluate(
    (el, selector) => {
      const r = el.getBoundingClientRect(),
        controls = Array.from(document.querySelectorAll(selector)),
        rects = controls.map((e) => e.getBoundingClientRect());
      return {
        centres: rects.map((r) => r.y + r.height / 2),
        order: controls.map((e) => e.getAttribute("aria-label")?.split(":")[0]),
        inside:
          rects.every((b) =>
            b.width > 0 && b.left >= r.left - .5 && b.right <= r.right + .5
          ) && el.scrollWidth <= el.clientWidth,
      };
    },
    promptFooterControls,
  );
  expect(g.centres).toHaveLength(count);
  expect(Math.max(...g.centres) - Math.min(...g.centres)).toBeLessThanOrEqual(
    .5,
  );
  expect(g.inside).toBe(true);
  return g;
}
export async function collections456(input: Inputs) {
  const { state, page, cdp, themes, native, content, scenes, paint, shot } =
    input;
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `Draft line ${i + 1}`).join("\n");
  const nativePage = async (id: string, reload = false) => {
    const since = input.traffic.sent.length,
      receivedSince = input.traffic.received.length;
    if (reload) await page.reload();
    else await page.goto(native.url + "/#/local/" + id);
    // The legacy sizing scene joins these same viewing receipts. Mounted
    // controls precede their completion; their feedback adds a notice row.
    for (const method of ["layout.location", "sessions.seen"]) {
      await expect.poll(() =>
        input.traffic.sent.slice(since).some(({ frame }) =>
          frame.t === "request" && frame.method === method &&
          frame.params?.sessionID === id &&
          input.traffic.received.slice(receivedSince).some((result) =>
            result.t === "request.result" &&
            result.ref?.key === frame.ref?.key &&
            (result.outcome as { ok?: boolean })?.ok
          )
        ) ||
        method === "layout.location" &&
          input.traffic.received.slice(receivedSince).some((frame) =>
            // A restored location is deliberately not written again. The boot
            // preferences are its authoritative receipt on a same-session reload.
            frame.t === "prefs" && (frame.prefs as {
              shellLayout?: { projectLocations?: { sessionID?: string }[] };
            }).shellLayout?.projectLocations?.some((location) =>
              location.sessionID === id
            )
          )
      ).toBe(true);
    }
    await expect(page.locator(".otk-composer-notice")).toHaveCount(0);
    await frames(page);
  };
  await test.step("4/native-composer", async () => {
    const restored = await state.native<{ id: string }>("/session", "POST", {
      title: "Restored native composer choice",
    });
    await state.native(`/session/${restored.id}/message`, "POST", {
      noReply: true,
      agent: "reviewer",
      model: { providerID: "fake2", modelID: "scripted" },
      variant: "high",
      parts: [{ type: "text", text: "Restored visual choice" }],
    });
    const images = await state.native<{ id: string }>("/session", "POST", {
      title: "Loaded native image",
    });
    await page.setViewportSize({ width: 1280, height: 657 });
    await nativePage(native.emptyID);
    const prompt = page.locator("textarea[name=prompt]");
    await expect(page.locator(".otk-variant-picker > button")).toHaveAttribute(
      "aria-label",
      "Variant: High (agent default)",
    );
    for (const theme of themes) {
      await test.step(theme.id, async () => {
        await paint(theme);
        await expect(page.locator(".otk-variant-picker > button"))
          .toHaveAttribute("aria-label", "Variant: High (agent default)");
        await prompt.fill("");
        await prompt.focus();
        await composerAccessories(page, theme, shot);
        await prompt.focus();
        const empty = await nativeInput(page);
        await expect(prompt).toHaveCSS("outline-style", "none");
        await expect(page.locator(".otk-composer")).toHaveCSS(
          "border-color",
          await token(page, "--otk-action-focus"),
        );
        expect(empty.height).toBe(48);
        await expect(page.locator(".otk-send-button")).toHaveCount(0);
        await footer(page, 6);
        await shot(`composer-empty-${theme.id}-1280`);
        for (let n = 1; n <= 14; n++) {
          if (n > 1) await page.keyboard.press("Shift+Enter");
          await page.keyboard.insertText(`Draft line ${n}`);
          await expect(prompt).toHaveValue(lines(n));
          const g = await nativeInput(page);
          expect(g.height).toBe(Math.min(240, Math.max(48, n * 24)));
          expect([g.line, g.resize]).toEqual(["24px", "none"]);
          expect(g.bottom).toBe(empty.bottom);
          expect(g.footer).toEqual(empty.footer);
          expect(g.top).toBe(empty.top - g.height + empty.height);
          expect(Math.abs(g.transcriptBottom - g.top)).toBeLessThanOrEqual(.5);
          expect(g.footer[0]).toBeGreaterThanOrEqual(g.inputBottom);
          expect(g.footer[1]).toBeLessThan(g.viewport);
          expect(g.scroll).toEqual([0, 0]);
          expect(g.caretTop).toBeGreaterThanOrEqual(0);
          expect(g.caretBottom).toBeLessThanOrEqual(g.height);
          if (n > 10) {
            expect(g.scrollHeight).toBeGreaterThan(g.height);
            expect(g.scrollTop).toBeGreaterThan(0);
          }
          if ([1, 4, 14].includes(n)) {
            await shot(`composer-${n}-${theme.id}-1280`);
          }
        }
        await prompt.fill("");
        expect((await nativeInput(page)).height).toBe(48);
        await prompt.fill(
          "The composer follows the draft as its words wrap across the available lane. "
            .repeat(4),
        );
        const wide = await nativeInput(page);
        await page.setViewportSize({ width: 1060, height: 657 });
        const narrow = await nativeInput(page);
        expect(narrow.height).toBeGreaterThan(wide.height);
        expect(narrow.height).toBeLessThanOrEqual(240);
        await page.setViewportSize({ width: 1280, height: 657 });
        expect((await nativeInput(page)).height).toBe(wide.height);
        await page.getByRole("button", { name: "Edit prompt", exact: true })
          .click();
        await page.locator("textarea[name=editor]").fill(lines(4));
        await shot(`composer-editor-${theme.id}-1280`);
        await page.locator(".otk-editor footer button:last-child").click();
        await expect(prompt).toHaveValue(lines(4));
        expect((await nativeInput(page)).height).toBe(96);
        await prompt.fill("Measure all available footer controls");
        const model = page.locator(".otk-model-picker > button"),
          variant = page.locator(".otk-variant-picker > button");
        const applied = await token(page, "--applied-fg");
        await expect(variant).toHaveCSS("color", applied);
        await expect(model).toHaveClass(/is-applied/);
        const modelGeometry = await model.evaluate((el) => {
          const p = el.querySelector(".otk-composer-provider")!
              .getBoundingClientRect(),
            m = el.querySelector(".otk-composer-model-name")!
              .getBoundingClientRect();
          return {
            gap: m.left - p.right,
            centre: Math.abs(p.y + p.height / 2 - m.y - m.height / 2),
          };
        });
        expect(modelGeometry.gap).toBe(8);
        expect(modelGeometry.centre).toBeLessThanOrEqual(.5);
        await expect(page.locator(".otk-composer-provider")).toHaveCSS(
          "color",
          applied,
        );
        await expect(page.locator(".otk-composer-model-name")).toHaveCSS(
          "color",
          applied,
        );
        const appliedBox = await variant.boundingBox();
        await variant.click();
        await page.locator(
          ".otk-variant-picker [data-picker-key=high] .otk-picker-option",
        ).click();
        await expect(variant).toHaveAttribute("aria-label", "Variant: High");
        await expect(variant).not.toHaveClass(/is-applied/);
        expect(await variant.boundingBox()).toEqual(appliedBox);
        expect(await variant.evaluate((el) => getComputedStyle(el).color)).not
          .toBe(applied);
        const explicit = await variant.evaluate((el) => ({
          text: el.textContent,
          font: getComputedStyle(el).font,
        }));
        await variant.click();
        await page.locator(
          '.otk-variant-picker [data-picker-key=""] .otk-picker-option',
        ).click();
        await expect(variant).toHaveAttribute(
          "aria-label",
          "Variant: High (agent default)",
        );
        await expect(variant).toHaveCSS("color", applied);
        expect(await variant.boundingBox()).toEqual(appliedBox);
        expect(
          await variant.evaluate((el) => ({
            text: el.textContent,
            font: getComputedStyle(el).font,
          })),
        ).toEqual(explicit);
        await variant.click();
        await expect(page.locator('.otk-variant-picker [data-picker-key=""]'))
          .toHaveAttribute("aria-selected", "true");
        await expect(
          page.locator('.otk-variant-picker [data-picker-key=""] small'),
        ).toHaveText("High");
        await expect(page.locator(".otk-variant-picker [data-picker-key=high]"))
          .toHaveAttribute("aria-selected", "false");
        const pointer = await selectionGeometry({
          send: (method, params = {}) =>
            cdp.send(method as Parameters<CDPSession["send"]>[0], params),
        }, '.otk-variant-picker [data-picker-key=""]');
        expect(pointer).toHaveLength(1);
        expect([pointer[0].w, pointer[0].h, pointer[0].selected]).toEqual([
          3,
          14,
          true,
        ]);
        expect(pointer[0].centred).toBeLessThanOrEqual(.5);
        await page.keyboard.press("Escape");
        await variant.click();
        await page.locator(
          ".otk-variant-picker [data-picker-key=high] .otk-picker-option",
        ).click();
        await model.click();
        await page.locator(".otk-model-picker input[type=search]").fill(
          "Scripted with variants",
        );
        await page.locator(
          '.otk-model-picker [data-picker-key=\'["fake2","scripted"]\'] .otk-picker-option',
        ).click();
        await expect(model).not.toHaveClass(/is-applied/);
        await expect(page.locator(".otk-composer-provider")).toHaveCSS(
          "color",
          applied,
        );
        expect(
          await page.locator(".otk-composer-model-name").evaluate((el) =>
            getComputedStyle(el).color ===
              getComputedStyle(el.closest("button")!).color
          ),
        ).toBe(true);
        await footer(page, 7);
        await shot(`composer-chosen-${theme.id}-1280`);
        await page.locator(".otk-agent-picker > button").click();
        await page.locator(
          ".otk-agent-picker [data-picker-key=reviewer] .otk-picker-option",
        ).click();
        await expect(page.locator(".otk-composer-agent")).toHaveCSS(
          "color",
          "rgb(18, 171, 239)",
        );
        const chevrons = await page.locator(
          ".otk-prompt-context > .otk-popover > button",
        ).evaluateAll((els) =>
          els.map((el) => {
            const a = el.querySelector("span")!.getBoundingClientRect(),
              b = el.querySelector("svg")!.getBoundingClientRect();
            return {
              label: el.getAttribute("aria-label"),
              delta: Math.abs(a.y + a.height / 2 - b.y - b.height / 2),
            };
          })
        );
        expect(chevrons.map((c) => c.label)).toEqual([
          "Agent: Reviewer",
          "Model: Second fixture provider Scripted with variants",
          "Variant: High",
        ]);
        for (const c of chevrons) expect(c.delta).toBeLessThanOrEqual(.5);
        expect(
          await page.locator(".otk-composer-provider,.otk-composer-model-name")
            .evaluateAll((els) =>
              els.every((el) => el.scrollWidth <= el.clientWidth)
            ),
        ).toBe(true);
        for (
          const [kind, key] of [["agent", "reviewer"], [
            "model",
            JSON.stringify(["fake2", "scripted"]),
          ], ["variant", "high"]]
        ) {
          const before = await prompt.boundingBox(),
            trigger = page.locator(`.otk-${kind}-picker > button`);
          await trigger.click();
          const panel = page.locator(`.otk-${kind}-picker .otk-surface`);
          await expect(panel).toBeVisible();
          await frames(page);
          expect(await prompt.boundingBox()).toEqual(before);
          const a = (await trigger.boundingBox())!,
            b = (await panel.boundingBox())!;
          expect(b.y + b.height).toBeLessThanOrEqual(a.y + .5);
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.x + b.width).toBeLessThanOrEqual(1280);
          expect(
            Math.abs(
              a.x + b.width <= 1280 ? b.x - a.x : b.x + b.width - a.x - a.width,
            ),
          ).toBeLessThanOrEqual(.5);
          const selector = `.otk-${kind}-picker [data-picker-key=${
            JSON.stringify(key)
          }]`;
          const pointers = await selectionGeometry({
            send: (method, params = {}) =>
              cdp.send(method as Parameters<CDPSession["send"]>[0], params),
          }, selector);
          expect(pointers).toHaveLength(1);
          expect([
            pointers[0].selected,
            pointers[0].ariaSelected,
            pointers[0].w,
            pointers[0].h,
            pointers[0].start,
            pointers[0].shift,
          ]).toEqual([true, "true", 3, 14, 3, 0]);
          expect(pointers[0].centred).toBeLessThanOrEqual(.5);
          expect(
            await page.locator(selector).evaluate((el) => {
              const r = el.getBoundingClientRect(),
                list = el.closest(".otk-picker-groups")!
                  .getBoundingClientRect();
              return r.top >= list.top - .5 && r.bottom <= list.bottom + .5 &&
                r.top >= 0 && r.bottom <= innerHeight;
            }),
          ).toBe(true);
          if (kind === "model") {
            expect(
              await page.locator(".otk-model-picker section").evaluateAll((
                sections,
              ) =>
                sections.filter((section) =>
                  !["Favourites", "Recent"].includes(
                    section.querySelector("h3")?.textContent ?? "",
                  )
                )
                  .flatMap((section) =>
                    Array.from(
                      section.querySelectorAll(".otk-picker-name small"),
                    )
                  ).length
              ),
            ).toBe(0);
            const row = page.locator(selector),
              action = row.locator(".otk-picker-action");
            const geometry = await row.evaluate((el) => {
              const action = el.querySelector(".otk-picker-action")!,
                a = action.getBoundingClientRect(),
                r = el.getBoundingClientRect();
              return {
                inside: a.left >= r.left && a.right <= r.right &&
                  a.top >= r.top && a.bottom <= r.bottom,
                shared: action.closest("[data-otk-selection]") === el,
                centre: Math.abs(a.y + a.height / 2 - r.y - r.height / 2),
                icon:
                  action.querySelector("svg")!.getBoundingClientRect().width,
                common:
                  document.querySelector(".otk-prompt-actions > button svg")!
                    .getBoundingClientRect().width,
              };
            });
            expect(geometry.inside && geometry.shared).toBe(true);
            expect(geometry.centre).toBeLessThanOrEqual(.5);
            expect(geometry.icon).toBe(geometry.common);
            await action.click();
            await expect(page.locator(".otk-model-picker h3").first())
              .toHaveText("Favourites");
            await expect(row.locator(".otk-picker-name small")).toHaveText(
              "Second fixture provider",
            );
            const favouritePointer = await selectionGeometry({
              send: (method, params = {}) =>
                cdp.send(method as Parameters<CDPSession["send"]>[0], params),
            }, selector);
            expect(favouritePointer).toHaveLength(1);
            expect([
              favouritePointer[0].selected,
              favouritePointer[0].w,
              favouritePointer[0].h,
            ]).toEqual([true, 3, 14]);
            expect(favouritePointer[0].centred).toBeLessThanOrEqual(.5);
            expect(
              await action.evaluate((el) => {
                const a = el.getBoundingClientRect(),
                  r = el.closest("[data-picker-key]")!.getBoundingClientRect();
                return a.left >= r.left && a.right <= r.right &&
                  a.top >= r.top && a.bottom <= r.bottom &&
                  Math.abs(a.y + a.height / 2 - r.y - r.height / 2) <= .5;
              }),
            ).toBe(true);
            expect(
              await action.locator("svg").evaluate((el) =>
                el.getBoundingClientRect().width
              ),
            ).toBe(geometry.common);
            await shot(`composer-favourite-${theme.id}-1280`);
            await row.locator(".otk-picker-action").click();
          }
          await shot(`composer-picker-${kind}-${theme.id}-1280`);
          await page.keyboard.press("Escape");
        }
        for (
          const [width, truncated] of [[1180, false], [1060, true]] as const
        ) {
          await page.setViewportSize({ width, height: 657 });
          await frames(page);
          expect(
            await page.locator(".otk-composer-provider").evaluate((el) =>
              el.scrollWidth > el.clientWidth
            ),
          ).toBe(true);
          expect(
            await page.locator(".otk-composer-model-name").evaluate((el) =>
              el.scrollWidth > el.clientWidth
            ),
          ).toBe(truncated);
          await footer(page, 7);
          await shot(`composer-responsive-${theme.id}-${width}`);
        }
        for (const width of [1280, 1060]) {
          await page.setViewportSize({ width, height: 657 });
          const before = await page.locator(
            ".otk-prompt-context > .otk-popover > button",
          ).evaluateAll((els) =>
            els.map((el) => el.getBoundingClientRect().left)
          );
          for (const on of [false, true, false]) {
            const toggle = page.locator(".otk-auto-approve-toggle");
            if (await toggle.getAttribute("aria-pressed") !== String(on)) {
              await toggle.click();
            }
            await prompt.click();
            await expect(toggle).toHaveAttribute("aria-pressed", String(on));
            await expect(toggle).toHaveAttribute("aria-label", "Auto-approve");
            expect(
              await toggle.evaluate((el) => el.classList.contains("is-on")),
            ).toBe(on);
            expect((await toggle.boundingBox())!.width).toBe(28);
            expect((await toggle.boundingBox())!.height).toBe(28);
            await expect(toggle).toHaveCSS(
              "color",
              await token(page, on ? "--otk-action-text" : "--otk-fg-3"),
            );
            expect(
              await toggle.evaluate((el) =>
                el.classList.contains("is-selected") ||
                el.classList.contains("otk-selection-item") ||
                el.hasAttribute("data-otk-selection") ||
                ["::before", "::after"].some((p) =>
                  !["none", "normal"].includes(getComputedStyle(el, p).content)
                )
              ),
            ).toBe(false);
            expect((await footer(page, 7)).order).toEqual([
              "Auto-approve",
              "Agent",
              "Model",
              "Variant",
              "Attach files",
              "Edit prompt",
              "Send",
            ]);
            expect(
              await page.locator(".otk-prompt-context > .otk-popover > button")
                .evaluateAll((els) =>
                  els.map((el) => el.getBoundingClientRect().left)
                ),
            ).toEqual(before);
            await shot(`composer-auto-${on}-${theme.id}-${width}`);
          }
        }
        await page.setViewportSize({ width: 1280, height: 657 });
        const image = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 400;
          const ctx = canvas.getContext("2d")!;
          ctx.fillStyle = "#234651";
          ctx.fillRect(0, 0, 640, 400);
          ctx.fillStyle = "#7fc8b8";
          ctx.fillRect(40, 40, 240, 240);
          ctx.fillStyle = "#f2c16d";
          ctx.beginPath();
          ctx.arc(440, 160, 100, 0, Math.PI * 2);
          ctx.fill();
          return canvas.toDataURL("image/png");
        });
        await page.evaluate((image) => {
          const data = new DataTransfer();
          data.items.add(
            new File(
              [Uint8Array.from(
                atob(image.split(",")[1]),
                (c) => c.charCodeAt(0),
              )],
              "sample.png",
              { type: "image/png" },
            ),
          );
          document.querySelector("textarea[name=prompt]")!.dispatchEvent(
            new ClipboardEvent("paste", { bubbles: true, clipboardData: data }),
          );
        }, image);
        await expect(page.locator(".otk-prompt-chip")).toHaveCount(1);
        await expect.poll(() =>
          page.locator(".otk-prompt-chip img").evaluate((el) =>
            (el as HTMLImageElement).naturalWidth
          )
        ).toBe(640);
        expect(await page.locator(".otk-prompt-chip img").getAttribute("src"))
          .toBe(image);
        expect(
          await page.locator(".otk-prompt-chip").evaluate((el) => {
            const a = el.querySelector("img")!.getBoundingClientRect(),
              b = el.querySelector("button:last-child")!
                .getBoundingClientRect();
            return Math.abs(a.y + a.height / 2 - b.y - b.height / 2);
          }),
        ).toBeLessThanOrEqual(.5);
        await shot(`composer-image-${theme.id}-1280`);
        await page.locator(".otk-prompt-chip button:last-child").click();
        await loadedImage({
          state,
          page,
          sessionID: images.id,
          nativePage,
          theme,
          image,
          shot,
        });
        await nativePage(native.emptyID);
        await prompt.fill("");
        await prompt.press("!");
        await page.keyboard.insertText("printf shell-source");
        await expect(prompt).toHaveAccessibleName("Shell");
        await shot(`composer-shell-${theme.id}-1280`);
        await prompt.press("Escape");
        await expect(prompt).toHaveAccessibleName("Prompt");
        await prompt.fill("");
        // Reset choices through native session remount, retaining the same stack.
        await nativePage(native.emptyID, true);
        await expect(variant).toHaveAttribute(
          "aria-label",
          "Variant: High (agent default)",
        );
        for (
          const [agent, label, choice] of [["plan", "Plan", "Low"], [
            "build",
            "Build",
            "High",
          ]]
        ) {
          await page.locator(".otk-agent-picker > button").click();
          await page.locator(
            `.otk-agent-picker [data-picker-key=${agent}] .otk-picker-option`,
          ).click();
          await expect(page.locator(".otk-composer-agent")).toHaveText(label);
          await expect(page.locator(".otk-variant-picker > button > span"))
            .toHaveText(choice);
          await shot(`composer-${agent}-${theme.id}-1280`);
        }
        await nativePage(restored.id);
        for (const kind of ["agent", "model", "variant"]) {
          await expect(page.locator(`.otk-${kind}-picker > button`)).not
            .toHaveClass(/is-applied/);
        }
        await expect(page.locator(".otk-variant-picker > button"))
          .toHaveAttribute("aria-label", "Variant: High");
        await expect(page.locator(".otk-composer-provider")).toHaveText(
          "Second fixture provider",
        );
        await expect(page.locator(".otk-composer-model-name")).toHaveText(
          "Scripted with variants",
        );
        await expect(page.locator(".otk-composer-provider")).toHaveCSS(
          "color",
          applied,
        );
        expect(
          await model.evaluate((el) => {
            const provider = el.querySelector(".otk-composer-provider")!,
              name = el.querySelector(".otk-composer-model-name")!,
              a = provider.getBoundingClientRect(),
              b = name.getBoundingClientRect();
            return b.left - a.right === 8 &&
              Math.abs(a.y + a.height / 2 - b.y - b.height / 2) <= .5 &&
              getComputedStyle(name).color === getComputedStyle(el).color;
          }),
        ).toBe(true);
        await shot(`composer-restored-${theme.id}-1280`);
        await nativePage(native.emptyID);
        await nativePage(native.emptyID, true);
      });
    }
  });
  const select = async (name: string) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    // Each fixed source owns its disclosure input. The files scene expands
    // changes; later scenes retain the legacy default instead of inheriting it.
    await state.product("prefs.set", {
      key: "collapseFileChanges",
      value: name !== "files",
    });
    await fixedContent(state, page, content.sessionID, name);
  };
  await test.step("5/public-takeovers", async () => {
    for (
      const scene of [
        "permission",
        "permission-read",
        "permission-edit",
        "question",
      ]
    ) {
      const kind = scene === "question" ? "question" : "permission";
      await select(scene);
      const dock = page.locator(`.otk-${kind}-dock`);
      await expect(dock).toBeVisible();
      for (const theme of themes) {
        await paint(theme);
        await expect(page.locator(".otk-composer")).toHaveAttribute(
          "data-takeover",
          "true",
        );
        await expect(dock.locator(".otk-surface")).toHaveCSS(
          "border-top-width",
          "1px",
        );
        await expect(page.locator(".otk-prompt")).toBeHidden();
        if (kind === "permission") {
          await expect(dock.locator(".otk-permission-summary")).toContainText(
            scene === "permission" ? "echo proof" : "README.md",
          );
        } else {
          const panel = dock.locator(".otk-tabs-panel[data-active=true]");
          await expect(dock.getByRole("tab")).toHaveCount(3);
          const items = await selectionGeometry(
            {
              send: (method, params = {}) =>
                cdp.send(method as Parameters<CDPSession["send"]>[0], params),
            },
            ".otk-tabs-panel[data-active=true] [data-otk-selection],.otk-question-dock .otk-tabs-strip [data-otk-selection]",
          );
          expect(items.length).toBeGreaterThanOrEqual(5);
          for (const item of items) {
            expect(item.shift).toBe(0);
            if (item.orientation === "vertical") {
              expect([item.w, item.h]).toEqual([3, 14]);
              expect(item.centred).toBeLessThanOrEqual(.5);
            } else expect(item.h).toBe(2);
          }
          await panel.locator("textarea").fill("My own output");
          await expect(panel.locator("textarea")).toHaveCSS(
            "outline-style",
            "none",
          );
          await expect(panel.locator("[data-question-row]:has(textarea)"))
            .toHaveCSS(
              "outline-style",
              "solid",
            );
          expect(
            await panel.locator("[data-question-row]:has(textarea)").evaluate(
              (el) => {
                const r = el.getBoundingClientRect(),
                  clip = el.closest(".otk-tabs-panels")!
                    .getBoundingClientRect(),
                  s = getComputedStyle(el),
                  out = Math.max(
                    0,
                    parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset),
                  );
                return r.left - out >= clip.left &&
                  r.right + out <= clip.right && r.top - out >= clip.top &&
                  r.bottom + out <= clip.bottom;
              },
            ),
          ).toBe(true);
          await panel.locator("textarea").press("Enter");
          const primary = dock.locator(".otk-question-actions .otk-primary");
          await expect(primary).toBeFocused();
          await expect(primary).toHaveCSS("outline-style", "solid");
          const ratio = await primary.evaluate((el) => {
            const s = getComputedStyle(el),
              lum = (rgb: string) =>
                rgb.match(/[\d.]+/g)!.slice(0, 3).map((p) => Number(p) / 255)
                  .map((c) =>
                    c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4
                  ).reduce(
                    (sum, c, i) => sum + c * [.2126, .7152, .0722][i],
                    0,
                  ),
              a = lum(s.outlineColor),
              b = lum(s.backgroundColor);
            return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
          });
          expect(ratio).toBeGreaterThanOrEqual(3);
          expect(
            await page.evaluate(() => {
              const prior = document.activeElement as HTMLElement;
              const styles = [
                '<div tabindex="-1"></div>',
                '<div tabindex="0"></div>',
                '<div role="region" tabindex="0"></div>',
                '<div role="tabpanel" tabindex="0"></div>',
                '<section tabindex="0"></section>',
              ].map((html) => {
                const host = document.createElement("div");
                host.innerHTML = html;
                const el = host.firstElementChild as HTMLElement;
                document.body.append(el);
                el.focus();
                const outline = getComputedStyle(el).outlineStyle;
                el.remove();
                return outline;
              });
              prior.focus();
              return styles;
            }),
          ).toEqual(["none", "none", "none", "none", "none"]);
          await shot(`takeover-own-answer-${theme.id}-1280`);
          await dock.getByRole("tab", { name: /Details/ }).click();
          await dock.locator(".otk-tabs-panel[data-active=true] button").first()
            .click();
          await shot(`takeover-multiple-${theme.id}-1280`);
          await dock.getByRole("tab").last().click();
          await shot(`takeover-review-${theme.id}-1280`);
          await dock.getByRole("tab").first().click();
        }
        await shot(`takeover-${scene}-${theme.id}-1280`);
      }
      if (kind === "permission") {
        await dock.locator(".otk-permission-actions button").first().click();
      } else {
        await dock.getByRole("tab").last().click();
        await dock.locator(".otk-question-submit").click();
      }
      await expect(page.locator(".otk-takeover-notice .is-pending"))
        .toBeVisible();
      for (const theme of themes) {
        await paint(theme);
        await expect(page.locator(".otk-takeover-notice [role=status]"))
          .toHaveCount(1);
        await expect(dock.locator(".otk-field-feedback")).toHaveCount(0);
        const icon = await page.locator(
          ".otk-takeover-notice .otk-composer-notice-icon",
        ).evaluate((el) => {
          const a = el.getBoundingClientRect(),
            svg = el.querySelector("svg")!.getBoundingClientRect();
          return {
            size: [svg.width, svg.height],
            text: el.textContent,
            gaps: [
              svg.left - a.left,
              a.right - svg.right,
              svg.top - a.top,
              a.bottom - svg.bottom,
            ],
          };
        });
        expect(icon.size).toEqual([16, 16]);
        expect(icon.text).toBe("");
        expect(Math.max(...icon.gaps) - Math.min(...icon.gaps))
          .toBeLessThanOrEqual(1);
        if (kind === "question") {
          await expect(dock.locator(".otk-surface-actions")).toHaveCount(0);
        }
        await shot(`takeover-pending-${kind}-${theme.id}-1280`);
      }
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "fail",
      });
      await expect(page.locator(".otk-takeover-notice [role=alert]"))
        .toHaveCount(1);
      for (const theme of themes) {
        await paint(theme);
        await expect(page.locator(".otk-takeover-notice")).not.toContainText(
          "/secret/path",
        );
        await shot(`takeover-failure-${kind}-${theme.id}-1280`);
      }
    }
  });
  await test.step("5/public-joined-notice-and-fork", async () => {
    await page.goto(
      scenes + "/?scene=notices&server=" + encodeURIComponent(state.url),
    );
    await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
    for (const theme of themes) {
      await paint(theme);
      let baseline: { row: number; notice: number; icon: number[] } | undefined;
      for (const mode of ["strip", "pending", "error", "fork"]) {
        await page.locator(`[data-theme-notice=${mode}]`).click();
        await frames(page);
        await expect(page.locator(".otk-composer-notice")).toHaveCount(1);
        await expect(page.locator(".otk-composer-notice-row")).toHaveCount(1);
        const g = await page.locator(".otk-composer-notice").evaluate((el) => {
          const row = el.querySelector(".otk-composer-notice-row")!,
            text = row.querySelector(".otk-composer-notice-content")!,
            icon = row.querySelector(".otk-composer-notice-icon")!,
            r = row.getBoundingClientRect(),
            t = text.getBoundingClientRect(),
            i = icon.getBoundingClientRect(),
            n = el.getBoundingClientRect(),
            input = document.querySelector(".otk-composer-input")!
              .getBoundingClientRect();
          return {
            row: r.height,
            notice: n.height,
            icon: [i.width, i.height],
            text: Math.abs(t.top + t.height / 2 - r.top - r.height / 2),
            iconOffset: i.top + i.height / 2 - r.top - r.height / 2,
            joined: n.left === input.left && n.right === input.right &&
              Math.abs(n.bottom - input.top) <= 1,
          };
        });
        baseline ??= { row: g.row, notice: g.notice, icon: g.icon };
        expect({ row: g.row, notice: g.notice, icon: g.icon }).toEqual(
          baseline,
        );
        expect(g.icon).toEqual([g.row, g.row]);
        expect(g.text).toBeLessThanOrEqual(.5);
        expect(g.iconOffset).toBe(0);
        expect(g.joined).toBe(true);
        await expect(page.locator("[disabled],[aria-disabled=true]"))
          .toHaveCount(0);
        if (mode === "pending") {
          await expect(page.locator(".otk-composer-notice [role=status]"))
            .toHaveCount(1);
        }
        if (mode === "error") {
          await expect(page.locator(".otk-composer-notice [role=alert]"))
            .toHaveCount(1);
        }
        if (mode === "fork") {
          await expect(page.locator(".otk-fork-note")).toContainText(
            "Original conversation",
          );
          await expect(page.locator(".otk-fork-note")).toContainText(
            "Files are shared with the original.",
          );
          expect(
            await page.locator(".otk-fork-note").evaluate((note) => {
              const button = note.querySelector("button")!;
              const rect = (el: Element) => {
                const r = el.getBoundingClientRect();
                return [r.width, r.height];
              };
              return [
                rect(button),
                rect(note.querySelector(".otk-composer-notice-icon > svg")!),
                rect(button.querySelector("svg")!),
              ];
            }),
          ).toEqual([[28, 28], [16, 16], [16, 16]]);
        }
        await shot(`joined-${mode}-${theme.id}-1280`);
      }
    }
  });
  await test.step("6/public-content", async () => {
    await state.product("prefs.set", { key: "genericToolOutput", value: true });
    for (
      const name of [
        "tools",
        "files",
        "typed",
        "empty-results",
        "paths",
        "question-pending",
        "question-answered",
        "reading",
        "chips",
        "queued",
        "answered",
        "streaming",
        "complete",
        "interrupted",
        "recovery",
        "retry",
        "revert",
        "unreported",
        "disclosures",
        "metadata",
        "facts",
      ]
    ) {
      for (const theme of themes) {
        await test.step(`${name}/${theme.id}`, async () => {
          await select(name);
          await paint(theme);
          if (name === "unreported") {
            await expect(page.locator(".otk-model-picker > button"))
              .toContainText("Backend default (not reported)");
          }
          if (name === "retry") {
            await expect(page.locator(".otk-retry-banner strong")).toHaveText(
              "Retrying \u00b7 attempt 2",
            );
          }
          if (name === "disclosures") {
            const toggle = page.locator(".otk-tool-toggle");
            await expect(page.locator(".otk-tool-body .otk-code")).toHaveCount(
              0,
            );
            await toggle.click();
            await expect(page.locator(".otk-code")).toContainText(
              "foldedSecret",
            );
            await shot(`tool-disclosed-${theme.id}-1280`);
            await toggle.click();
            await expect(toggle).toHaveAttribute("aria-expanded", "false");
            await expect(page.locator(".otk-tool-body")).toHaveCount(0);
            await shot(`tool-folded-${theme.id}-1280`);
          }
          if (name === "metadata") {
            const rows = await page.locator(
              "[data-tool=search] .otk-tool-toggle",
            ).allTextContents();
            expect(rows).toHaveLength(2);
            expect(rows[0]).not.toContain("0 matches");
            expect(rows[0]).not.toContain("*");
            expect(rows[1]).toContain("0 matches");
            await page.locator("[data-tool=patch] .otk-tool-toggle").click();
            await expect(page.locator("[data-tool=patch] .otk-diff"))
              .toHaveAttribute("aria-label", "Change Path not reported");
            await expect(page.locator("[data-tool=patch] .otk-tool-target"))
              .toHaveText("Path not reported");
            await page.locator("[data-tool=external] .otk-tool-toggle").click();
            const output = page.locator("[data-tool=external] pre");
            for (const [i, count] of [10, 15, 10].entries()) {
              expect((await output.innerText()).split("\n")).toHaveLength(
                count,
              );
              if (i < 2) {
                await page.locator("[data-tool=external] .otk-output-toggle")
                  .click();
              }
            }
          }
          if (name === "facts") {
            await page.locator(".otk-agent-picker > button").click();
            await page.locator(
              ".otk-agent-picker [data-picker-key=action] .otk-picker-option",
            ).click();
            await page.locator("[data-tool=external] .otk-tool-toggle").click();
            await expect(page.locator("[data-tool=task] .otk-tool-target"))
              .toHaveText("Unknown agent");
            await expect(page.locator("[data-tool=external] small")).toHaveText(
              "Output truncated.",
            );
            await page.locator(".otk-message-agent").hover();
            await expect(page.locator(".otk-message-agent")).toHaveCSS(
              "color",
              await token(page, "--accent"),
            );
            await expect(page.locator(".otk-agent-picker > button")).toHaveCSS(
              "color",
              await token(page, "--accent"),
            );
            await page.locator(".otk-agent-picker > button").click();
            for (
              const [name, color] of [
                ["action", await token(page, "--accent")],
                ["alternate", await token(page, "--secondary")],
                ["literal", "rgb(18, 171, 239)"],
              ]
            ) {
              await expect(
                page.locator(
                  `.otk-agent-picker [data-picker-key=${name}] .otk-picker-name`,
                ),
              ).toHaveCSS("color", color);
            }
            await shot(`content-facts-picker-${theme.id}-1280`);
            await page.keyboard.press("Escape");
          }
          if (name === "tools") {
            for (
              const tool of [
                "bash",
                "read",
                "search",
                "fetch",
                "skill",
                "external",
              ]
            ) {
              const selector =
                `[data-tool=${tool}][data-tool-status=completed]`;
              await reveal(page, selector + " .otk-tool-toggle");
              const rows = page.locator(selector);
              for (let i = 0; i < await rows.count(); i++) {
                const toggle = rows.nth(i).locator(".otk-tool-toggle");
                if (await toggle.getAttribute("aria-expanded") === "false") {
                  await toggle.click();
                }
              }
              await expect(rows.first().locator(".otk-tool-body"))
                .toBeAttached();
              if (tool === "bash" || tool === "external") {
                const output = rows.first().locator(".otk-tool-output");
                expect((await output.innerText()).split("\n")).toHaveLength(10);
                await shot(`tool-${tool}-collapsed-${theme.id}-1280`);
                await rows.first().locator(".otk-output-toggle").click();
                expect((await output.innerText()).split("\n")).toHaveLength(
                  tool === "bash" ? 30 : 15,
                );
              }
              await shot(`tool-${tool}-${theme.id}-1280`);
            }
            for (const tool of ["bash", "websearch"]) {
              await reveal(
                page,
                `[data-tool=${tool}][data-tool-status=denied]`,
              );
              await shot(`tool-${tool}-denied-${theme.id}-1280`);
            }
            await reveal(
              page,
              "[data-tool=read][data-tool-status=error] .otk-tool-error-toggle",
            );
            await page.locator(
              "[data-tool=read][data-tool-status=error] .otk-tool-error-toggle",
            ).click();
            await expect(page.locator(".otk-tool-error")).toBeAttached();
            await reveal(page, "[data-tool=websearch]");
            await expect(page.locator("[data-tool=websearch]")).not
              .toContainText("count unavailable");
          }
          if (["typed", "empty-results", "paths"].includes(name)) {
            const ids = name === "typed"
              ? ["result-0", "result-1", "result-2", "result-3"]
              : name === "paths"
              ? [
                "false-read",
                "false-list",
                "false-glob",
                "true-read",
                "true-list",
                "true-glob",
                "cwd",
              ]
              : ["empty"];
            for (const id of ids) {
              const row = `[data-message="${id}"]`;
              await reveal(page, row + " .otk-tool-toggle");
              for (
                const toggle of await page.locator(row + " .otk-tool-toggle")
                  .all()
              ) {
                if (
                  await toggle.getAttribute("aria-expanded") === "false"
                ) await toggle.click();
              }
              await expect(page.locator(row + " .otk-tool-summary"))
                .toHaveCount(0);
              if (name === "paths") {
                await expect(page.locator(row + " .otk-tool-target"))
                  .toHaveText(
                    id === "cwd"
                      ? "pwd"
                      : id === "false-read"
                      ? "src/probe.txt"
                      : id.startsWith("false-")
                      ? "src"
                      : id === "true-read"
                      ? "/outside/probe.txt"
                      : "/outside",
                  );
              }
              await shot(`result-${id}-${theme.id}-1280`);
            }
            if (name === "typed") {
              await reveal(page, "[data-tool=read] .otk-code");
              await expect(page.locator("[data-tool=read] .otk-code-numbers"))
                .toHaveText("2\n3");
              await expect(
                page.locator("[data-tool=read] [data-tool-result-meta]"),
              ).toHaveText("2\u20133 of 4 lines \u00b7 More available");
              await expect(page.locator("[data-tool=read] .otk-token").first())
                .toBeAttached();
              await expect.poll(() =>
                page.locator("[data-tool=read] code").evaluate((el) => {
                  const walker = document.createTreeWalker(
                    el,
                    NodeFilter.SHOW_TEXT,
                  );
                  for (
                    let node = walker.nextNode();
                    node;
                    node = walker.nextNode()
                  ) {
                    const start = node.textContent!.indexOf(
                      "otk_result_marker",
                    );
                    if (start < 0) continue;
                    const range = document.createRange();
                    range.setStart(node, start);
                    range.setEnd(node, start + "otk_result_marker".length);
                    const r = range.getBoundingClientRect(),
                      viewport = el.closest(".otk-messages")!
                        .getBoundingClientRect(),
                      token = node.parentElement!.closest<HTMLElement>(
                        ".otk-token",
                      );
                    return r.top >= viewport.top &&
                      r.bottom <= viewport.bottom && r.left >= viewport.left &&
                      r.right <= viewport.right && !!token?.style.color &&
                      getComputedStyle(token).color !== "rgba(0, 0, 0, 0)";
                  }
                  return false;
                })
              ).toBe(true);
              await expect(page.locator(".otk-tool-summary")).toHaveCount(0);
            }
            if (name === "empty-results") {
              await expect(page.locator("[data-tool=read] .otk-tool-body"))
                .toContainText("No lines returned");
              await expect(page.locator("[data-tool=search] .otk-tool-output"))
                .toHaveText("No results");
              await expect(
                page.locator("[data-tool=search] [data-tool-result-meta]"),
              ).toHaveText("Offset 3 \u00b7 1 entry total");
              await expect(
                page.locator("[data-tool=read] [data-tool-result-meta]"),
              ).toHaveText("1 line total \u00b7 More available");
            }
          }
          if (
            ["files", "question-pending", "question-answered"]
              .includes(name)
          ) {
            // Native public disclosures admit the fixed expanded states; each is
            // captured before the viewport moves on to another source owner.
            const toggles = page.locator(".otk-tool-toggle");
            for (
              let i = 0;
              name !== "files" && i < await toggles.count();
              i++
            ) {
              const toggle = toggles.nth(i);
              if (await toggle.getAttribute("aria-expanded") === "false") {
                await toggle.click();
              }
            }
            if (name.startsWith("question-")) {
              await expect(page.locator(".otk-todos li")).toHaveCount(4);
              expect(
                await page.locator(".otk-todos li").evaluateAll((els) =>
                  els.map((el) => el.getAttribute("data-todo-status"))
                ),
              ).toEqual(["pending", "in_progress", "completed", "cancelled"]);
              await expect(page.locator(".otk-questions")).toContainText(
                name.endsWith("answered") ? "Typed" : "Awaiting answer",
              );
              await expect(
                page.locator(".otk-questions button,.otk-questions input"),
              ).toHaveCount(0);
            }
            if (name === "files") {
              await reveal(page, "[data-tool=edit] .otk-diff");
              for (const style of ["split", "unified"] as const) {
                await state.product("prefs.set", {
                  key: "diffWrap",
                  value: style === "split",
                });
                await state.product("prefs.set", {
                  key: "diffStyle",
                  value: style,
                });
                await expect(page.locator("[data-tool=edit] .otk-diff"))
                  .toHaveAttribute("data-diff-style", style);
                if (style === "split") {
                  await expect(page.locator("[data-tool=edit] .otk-diff"))
                    .toHaveClass(/otk-diff-wrap/);
                } else {
                  await expect(page.locator("[data-tool=edit] .otk-diff")).not
                    .toHaveClass(/otk-diff-wrap/);
                }
                await page.locator("[data-tool=edit] .otk-diff")
                  .scrollIntoViewIfNeeded();
                if (style === "split") {
                  expect(
                    await page.locator(".otk-diff-split-row").first().evaluate(
                      (el) => {
                        const a = el.children[0].getBoundingClientRect(),
                          b = el.children[1].getBoundingClientRect();
                        return Math.max(
                          Math.abs(a.height - b.height),
                          Math.abs(a.top - b.top),
                        );
                      },
                    ),
                  ).toBeLessThanOrEqual(.5);
                }
                await shot(`content-files-${style}-${theme.id}-1280`);
              }
              await reveal(page, "[data-tool=write] .otk-code");
              // Like the legacy file scene, join worker projection at the
              // rendered consumer rather than worker/WASM download completion.
              await expect.poll(() =>
                page.locator("[data-tool=write] .otk-token").evaluateAll((
                  els,
                ) =>
                  els.some((el) =>
                    !!(el as HTMLElement).style.color &&
                    getComputedStyle(el).color !== "rgba(0, 0, 0, 0)"
                  )
                )
              ).toBe(true);
              await expect(page.locator("[data-tool=write] .otk-code-numbers"))
                .toBeAttached();
              await expect(page.locator("[data-tool=write] .otk-diagnostics"))
                .toContainText("fixture diagnostic");
              await shot(`content-write-${theme.id}-1280`);
              await reveal(page, "[data-tool=patch] .otk-tool-toggle");
              expect(
                await page.locator("[data-tool=patch] .otk-diff").evaluateAll(
                  (els) => els.map((el) => el.getAttribute("data-file-status")),
                ),
              ).toEqual(["added", "modified", "deleted", "moved"]);
            }
          }
          if (name === "chips") {
            await expect(page.locator(".otk-compaction-divider")).toBeVisible();
            await expect(
              page.locator(".otk-user-bubble .otk-compaction-divider"),
            ).toHaveCount(0);
            await expect(page.locator(".otk-messages")).toContainText(
              "File: fixture.txt",
            );
            await expect(page.locator(".otk-messages")).toContainText(
              "Agent: general",
            );
          }
          if (name === "reading") {
            for (const width of [1280, 1600, 2000]) {
              await page.setViewportSize({ width, height: 1100 });
              await frames(page);
              const g = await page.evaluate(() => {
                const el = (s: string) => document.querySelector(s)!,
                  rect = (s: string) => el(s).getBoundingClientRect(),
                  lane = rect(".otk-message-flow"),
                  scroll = rect(".otk-messages"),
                  bubble = rect(".otk-user-bubble"),
                  composer = rect(".otk-composer"),
                  prose = rect("[data-message=reading] .otk-text p"),
                  code = rect("[data-message=reading] .otk-code"),
                  s = getComputedStyle(el(".otk-messages")),
                  p = getComputedStyle(
                    el("[data-message=reading] .otk-text p"),
                  );
                return {
                  lane: [lane.left, lane.right, lane.width],
                  expected: Math.min(
                    736,
                    el(".otk-messages").clientWidth -
                      parseFloat(s.paddingLeft) - parseFloat(s.paddingRight),
                  ),
                  centered: Math.abs(
                    lane.left + lane.right - scroll.left - scroll.right,
                  ),
                  composer: [composer.left, composer.right],
                  bubble: bubble.width <= lane.width * .8 + .5 &&
                    Math.abs(bubble.right - lane.right) < .5,
                  aligned: [
                    Math.abs(prose.width - code.width),
                    Math.abs(prose.left - code.left),
                  ],
                  font: p.fontFamily,
                  prose: [p.fontSize, p.lineHeight],
                  border: getComputedStyle(el(".otk-composer")).borderTopWidth,
                  radius: getComputedStyle(el(".otk-composer")).borderRadius,
                };
              });
              expect(g.lane[2]).toBe(g.expected);
              expect(g.centered).toBeLessThan(1);
              expect(Math.abs(g.lane[0] - g.composer[0])).toBeLessThanOrEqual(
                .5,
              );
              expect(Math.abs(g.lane[1] - g.composer[1])).toBeLessThanOrEqual(
                .5,
              );
              expect(g.bubble).toBe(true);
              for (const d of g.aligned) expect(d).toBeLessThanOrEqual(.5);
              expect(g.font).toContain("IBM Plex Sans");
              expect(
                await page.locator(".otk-message-footer").first().evaluate((
                  el,
                ) => getComputedStyle(el).fontFamily),
              ).toContain("IBM Plex Sans");
              expect(await page.locator(".otk-session-view").innerText()).not
                .toMatch(
                  /Enter to send|Shift\+Enter for newline|1 \/ 2 \/ 3|j\/k select/,
                );
              expect(g.prose).toEqual(["14px", "24px"]);
              expect([g.border, g.radius]).toEqual(["1px", "20px"]);
              await expect(page.locator(".otk-role-label")).toHaveCount(0);
              await shot(`reading-${theme.id}-${width}`);
            }
            await page.setViewportSize({ width: 1280, height: 900 });
            const fold = page.locator(".otk-work-fold").first();
            await expect(fold).toBeAttached();
            await expect(fold.locator(".otk-divider-label")).toHaveCSS(
              "font",
              await fold.evaluate((el) => getComputedStyle(el).font),
            );
            const rule = await fold.locator(".otk-divider-rule").evaluate(
              (el) => {
                const s = getComputedStyle(el),
                  canvas = document.createElement("canvas");
                canvas.width = canvas.height = 1;
                const ctx = canvas.getContext("2d")!,
                  rgb = (color: string) => {
                    ctx.clearRect(0, 0, 1, 1);
                    ctx.fillStyle = getComputedStyle(document.documentElement)
                      .backgroundColor;
                    ctx.fillRect(0, 0, 1, 1);
                    ctx.fillStyle = color;
                    ctx.fillRect(0, 0, 1, 1);
                    return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(
                      0,
                      3,
                    );
                  },
                  bg = rgb("transparent"),
                  distance = (a: number[]) =>
                    a.reduce(
                      (sum, value, i) => sum + Math.abs(value - bg[i]),
                      0,
                    );
                return {
                  width: s.borderTopWidth,
                  style: s.borderTopStyle,
                  ratio: distance(rgb(s.borderTopColor)) /
                    distance(rgb(s.color)),
                };
              },
            );
            expect([rule.width, rule.style]).toEqual(["1px", "solid"]);
            expect(rule.ratio).toBeGreaterThan(0);
            expect(rule.ratio).toBeLessThan(.2);
            await fold.click();
            await shot(`work-fold-${theme.id}-1280`);
            await fold.click();
            await shot(`work-expanded-${theme.id}-1280`);
            await expect(page.locator("[data-tool=task] .otk-tool-target"))
              .toHaveText("Unknown agent");
          }
          if (name === "streaming") {
            await expect(page.locator(".otk-response-progress")).toHaveCount(1);
            expect(
              await page.locator(".otk-response-progress").evaluate((el) => {
                const content = el.closest(".otk-message-content")!,
                  r = el.getBoundingClientRect(),
                  prior = el.previousElementSibling!.getBoundingClientRect(),
                  footer = el.closest("[data-message]")!.querySelector(
                    "footer",
                  )!.getBoundingClientRect();
                return content.lastElementChild === el &&
                  r.top >= prior.bottom && r.bottom <= footer.top &&
                  getComputedStyle(el).position === "static" &&
                  !document.querySelector(
                    "[data-message=earlier] .otk-response-progress",
                  );
              }),
            ).toBe(true);
            await expect(page.locator(".otk-response-glimmer")).toHaveCSS(
              "display",
              "none",
            );
            await expect(page.locator(".otk-response-progress-text"))
              .toHaveText("response in progress");
            await state.product("prefs.set", {
              key: "animationsOff",
              value: false,
            });
            await page.emulateMedia({ reducedMotion: "no-preference" });
            await expect(page.locator(".otk-response-glimmer")).toHaveCSS(
              "height",
              "2px",
            );
            await expect(page.locator(".otk-response-glimmer")).toBeVisible();
            expect(
              await page.locator(".otk-response-glimmer").evaluate((el) =>
                el.getBoundingClientRect().width ===
                  el.closest(".otk-message-content")!.getBoundingClientRect()
                    .width
              ),
            ).toBe(true);
            expect(
              await page.locator(".otk-response-glimmer").evaluate((el) =>
                getComputedStyle(el).animationName
              ),
            ).not.toBe("none");
            await page.emulateMedia({ reducedMotion: "reduce" });
            await expect(page.locator(".otk-response-progress-text")).toHaveCSS(
              "display",
              "flex",
            );
            await expect(page.locator(".otk-response-progress-text")).toHaveCSS(
              "height",
              "20px",
            );
            await expect(page.locator(".otk-response-glimmer")).toHaveCSS(
              "animation-name",
              "none",
            );
            await state.product("prefs.set", {
              key: "animationsOff",
              value: true,
            });
            await page.emulateMedia({ reducedMotion: "no-preference" });
          }
          if (name === "queued" || name === "answered") {
            await expect(page.locator(".otk-queued")).toHaveCount(
              name === "queued" ? 1 : 0,
            );
            await page.locator(".otk-message-agent").first().click();
            await expect(page.locator(".otk-message-agent").first()).toHaveCSS(
              "color",
              "rgb(107, 172, 255)",
            );
            await expect(page.locator("[data-role=user]").first()).toHaveCSS(
              "border-left-width",
              "0px",
            );
          }
          if (name === "complete" || name === "interrupted") {
            await expect(page.locator(".otk-response-progress")).toHaveCount(0);
          }
          if (name === "interrupted") {
            await expect(page.locator("[data-message=reply] footer"))
              .toContainText("interrupted");
          }
          if (name === "recovery") {
            await expect(page.locator(".otk-response-recovery")).toHaveText(
              "Refreshing response\u2026",
            );
          }
          if (name === "revert") {
            await expect(page.locator(".otk-rolled-back-strip")).toContainText(
              "1 prompt rolled back",
            );
            const joined = await page.evaluate(() => {
              const a = document.querySelector(".otk-composer-notice")!
                  .getBoundingClientRect(),
                b = document.querySelector(".otk-composer-input")!
                  .getBoundingClientRect();
              return [
                a.left === b.left,
                a.right === b.right,
                Math.abs(a.bottom - b.top) <= 1,
              ];
            });
            expect(joined).toEqual([true, true, true]);
            expect(
              await page.evaluate(() =>
                document.querySelector(".otk-prompt")!.getBoundingClientRect()
                  .top >=
                  document.querySelector(".otk-composer-input")!
                    .getBoundingClientRect().top
              ),
            ).toBe(true);
            await page.locator(".otk-rollback-disclosure").click();
            await expect(page.locator(".otk-rollback-details")).toContainText(
              "revert.txt",
            );
          }
          await shot(`content-${name}-${theme.id}-1280`);
        });
      }
    }
  });
  await test.step("5-6/public-style-boundaries", async () => {
    for (
      const scene of [
        "notice-lifetime",
        "feedback-owners",
        "requests",
        "prose",
        "journal",
        "siblings",
      ]
    ) {
      await page.goto(
        scenes + "/styles/?scene=" + scene + "&server=" +
          encodeURIComponent(state.url),
      );
      await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
      for (const theme of themes) {
        await paint(theme);
        if (scene === "notice-lifetime") {
          await page.evaluate(
            "styleTest.resetNotice();styleTest.settleNotice()",
          );
          const disclosure = page.locator(".otk-rollback-disclosure");
          // Publications retain disclosure state across theme paints.
          if (await disclosure.getAttribute("aria-expanded") !== "true") {
            await disclosure.click();
          }
          await expect(disclosure).toHaveAttribute("aria-expanded", "true");
          await expect(page.locator(".otk-rollback-footer button"))
            .toBeVisible();
        }
        if (scene === "feedback-owners") {
          await page.evaluate(
            "styleTest.mountFeedback(true);styleTest.feedbackOwner(1);styleTest.emitFeedback(1,'connection')",
          );
          await expect(page.locator(".is-reconnecting")).toHaveText(
            "Replacement target",
          );
        }
        if (scene === "requests") {
          for (const width of [1280, 800]) {
            await page.setViewportSize({ width, height: 700 });
            await frames(page);
            let baseline: number[][] | undefined;
            for (const status of ["clear", "pending", "error"]) {
              await page.evaluate(`styleTest.feedback('${status}')`);
              await frames(page);
              const rects = await page.locator(
                ".request-feedback-form input,#task-feedback",
              ).evaluateAll((els) =>
                els.map((el) => {
                  const r = el.getBoundingClientRect();
                  return [r.x, r.y, r.width, r.height];
                })
              );
              baseline ??= rects;
              expect(rects).toEqual(baseline);
              const centres = await page.evaluate(() => {
                const pane = document.querySelector(".request-feedback-pane")!,
                  p = pane.getBoundingClientRect(),
                  items = Array.from(pane.querySelectorAll("p,button")).map(
                    (el) => el.getBoundingClientRect(),
                  ),
                  left = Math.min(...items.map((r) => r.left)),
                  right = Math.max(...items.map((r) => r.right)),
                  top = Math.min(...items.map((r) => r.top)),
                  bottom = Math.max(...items.map((r) => r.bottom)),
                  rows = Array.from(
                    document.querySelector(".otk-operation-feedback")!.children,
                  ).map((el) => {
                    const r = el.getBoundingClientRect();
                    return r.y + r.height / 2;
                  });
                return [
                  Math.abs((p.left + p.right - left - right) / 2),
                  Math.abs((p.top + p.bottom - top - bottom) / 2),
                  Math.max(...rows) - Math.min(...rows),
                ];
              });
              for (const delta of centres) expect(delta).toBeLessThan(1);
              await expect(page.locator("[disabled],[aria-disabled=true]"))
                .toHaveCount(0);
              if (status === "error") {
                expect(await token(page, "--otk-danger")).not.toBe(
                  await token(page, "--otk-focus"),
                );
                await expect(page.locator(".otk-operation-feedback")).toHaveCSS(
                  "color",
                  await token(page, "--otk-danger"),
                );
              }
              await shot(`notice-${status}-${theme.id}-${width}`);
            }
          }
          await page.setViewportSize({ width: 1280, height: 900 });
        }
        if (scene === "prose") {
          await page.evaluate("styleTest.conceal(false)");
          const values = await page.evaluate(() =>
            ["standalone", "reasoning", "textpart"].map((id) => {
              const el = document.getElementById(id)!,
                p = el.querySelector("p")!,
                s = getComputedStyle(p);
              return [
                s.fontSize,
                s.lineHeight,
                getComputedStyle(p.querySelector("code")!).backgroundColor,
                getComputedStyle(p.querySelector("strong")!, "::before")
                  .content,
                getComputedStyle(el.querySelector("blockquote")!)
                  .borderLeftWidth,
                getComputedStyle(el.querySelector("pre")!).lineHeight,
              ];
            })
          );
          for (const value of values) {
            expect(value).toEqual(values[0]);
            expect([value[0], value[1], ...value.slice(3)]).toEqual([
              "14px",
              "24px",
              '"**"',
              "2px",
              "20px",
            ]);
          }
          await expect(page.locator("#standalone pre")).toHaveCSS(
            "content",
            '"```"',
            { pseudo: "before" },
          );
          await page.evaluate(
            "styleTest.conceal(true);document.body.classList.add('otk-unconcealed')",
          );
          await expect(page.locator("#textpart strong")).toHaveCSS(
            "content",
            "none",
            { pseudo: "before" },
          );
          await expect(page.locator("#standalone strong")).toHaveCSS(
            "content",
            "none",
            { pseudo: "before" },
          );
          await expect(page.locator("#standalone pre")).toHaveCSS(
            "content",
            "none",
            { pseudo: "before" },
          );
          await page.evaluate(
            "document.body.classList.remove('otk-unconcealed');styleTest.conceal(false)",
          );
        }
        if (scene === "journal") {
          await page.locator(".otk-permission-patterns").evaluateAll((els) =>
            els.forEach((el) => (el as HTMLDetailsElement).open = true)
          );
          const values = await page.evaluate(() =>
            ["summary", "activity"].map((id) =>
              Array.from(
                document.getElementById(id)!.querySelectorAll(
                  ".otk-permission-summary li",
                ),
              ).map((el) => {
                const s = getComputedStyle(el);
                return [
                  s.display,
                  s.paddingBottom,
                  s.borderBottomWidth,
                  s.flexDirection,
                  s.listStyleType,
                  el.getBoundingClientRect().height,
                ].join("|");
              })
            )
          );
          expect(values[0]).toHaveLength(4);
          expect(values[1]).toEqual(values[0]);
        }
        if (scene === "siblings") {
          await expect(page.locator(".otk-work-fold")).toHaveCSS(
            "display",
            "flex",
          );
          await expect(page.locator(".otk-view-header")).toHaveCSS(
            "display",
            "flex",
          );
          await expect(page.locator(".otk-empty")).toHaveCSS("padding", "12px");
          const disclosure = page.locator(".otk-rollback-disclosure");
          if (await disclosure.getAttribute("aria-expanded") !== "true") {
            await disclosure.click();
          }
          await expect(page.locator(".otk-rollback-file")).toHaveCount(1);
          const colors = await page.evaluate(() =>
            [".otk-path", ".otk-diff-add", ".otk-diff-del"].map((selector) =>
              getComputedStyle(
                document.querySelector(".otk-rollback-file " + selector)!,
              ).color
            )
          );
          expect(colors[1]).not.toBe(colors[0]);
          expect(colors[2]).not.toBe(colors[0]);
          await page.locator(".otk-work-fold").click();
          await expect(page.locator(".otk-work-body")).toHaveCount(0);
          await page.locator(".otk-work-fold").click();
          await expect(page.locator(".otk-work-body")).toBeVisible();
          await disclosure.click();
          await expect(page.locator(".otk-rollback-file")).toHaveCount(0);
        }
        await shot(`public-${scene}-${theme.id}-1280`);
      }
    }
  });
}
