// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../fixtures/evidence.ts";

test(
  "chrome.project-tab-overflow",
  { tag: ["@visual"] },
  async ({ state, page }, info) => {
    // Hold real catalog delivery: independent chrome must remain usable while
    // the composer can accept input but its optional choices are still unknown.
    const reads = new Set<string>();
    const held: (() => void)[] = [];
    let holding = true;
    await page.routeWebSocket("**/ws", (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (frame.t === "request" && frame.method === "catalogs.watch") {
          reads.add(frame.ref.key);
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = JSON.parse(message.toString());
        if (
          holding &&
          (frame.t.startsWith("catalog.") || reads.has(frame.ref?.key))
        ) held.push(() => socket.send(message));
        else socket.send(message);
      });
    });
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Project tab geometry",
    });
    await state.product("prefs.set", { key: "animationsOff", value: true });
    await page.goto(`${state.url}/#/local/${session.id}`);
    const tabs = page.getByRole("region", {
      name: "Project tabs",
      exact: true,
    });
    await expect(tabs.getByRole("button", { name: "New task", exact: true }))
      .toBeVisible();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    const composer = page.locator("textarea[name=prompt]");
    await composer.fill("Editable while project choices load");
    await expect(composer).toHaveValue("Editable while project choices load");
    await expect(page.getByText("Loading messages…", { exact: true }))
      .toBeHidden();
    await page.evaluate(() => document.fonts.ready);
    const label = tabs.locator(".otk-tabs-project");
    const name = state.directory.split("/").at(-1)!;
    expect(name.length).toBeGreaterThan(100);
    await expect(label).toHaveText(name);
    await expect(label).toHaveAttribute("title", state.directory);

    {
      const theme = "otk-dark";
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      for (const collapsed of [true, false]) {
        await state.product("layout.patch", {
          leftCollapsed: collapsed,
          rightCollapsed: collapsed,
        });
        await expect(page.locator(".otk-project-inbox"))
          .toHaveAttribute("data-collapsed", String(collapsed));
        await expect(page.getByRole("button", {
          name: collapsed ? "Open right panel" : "Collapse right panel",
          exact: true,
        })).toBeVisible();
        for (const width of collapsed ? [1280, 800, 600] : [1280]) {
          await page.setViewportSize({ width, height: 800 });
          const geometry = await tabs.evaluate((root) => {
            const strip = root.querySelector(".otk-task-strip")!;
            const project = root.querySelector<HTMLElement>(
              ".otk-tabs-project",
            )!;
            const list = root.querySelector(".otk-task-list")!;
            const s = strip.getBoundingClientRect();
            const p = project.getBoundingClientRect();
            const l = list.getBoundingClientRect();
            const style = getComputedStyle(strip);
            const actions = Array.from(
              strip.querySelectorAll<HTMLButtonElement>(
                ".otk-task-new, .otk-topbar-end button",
              ),
            ).map((control) => {
              const r = control.getBoundingClientRect();
              const icon = control.querySelector("svg")!
                .getBoundingClientRect();
              return {
                name: control.getAttribute("aria-label"),
                inside: r.left >= s.left + parseFloat(style.paddingLeft) &&
                  r.right <= s.right - parseFloat(style.paddingRight) + 0.5 &&
                  r.top >= s.top && r.bottom <= s.bottom,
                hit: control.contains(document.elementFromPoint(
                  r.x + r.width / 2,
                  r.y + r.height / 2,
                )),
                width: r.width,
                height: r.height,
                gaps: [
                  icon.left - r.left,
                  r.right - icon.right,
                  icon.top - r.top,
                  r.bottom - icon.bottom,
                ],
                listGap: r.left - l.right,
              };
            });
            const selected = list.querySelector(
              '[role="tab"][aria-selected="true"]',
            );
            const selectedRect = selected?.getBoundingClientRect();
            return {
              actions,
              labelWidth: p.width,
              clipped: project.scrollWidth > project.clientWidth,
              ellipsis: getComputedStyle(project).textOverflow,
              nowrap: getComputedStyle(project).whiteSpace,
              labelListGap: l.left - p.right,
              selectedVisible: !!selected?.checkVisibility() &&
                !!selectedRect && selectedRect.width > 0 &&
                selectedRect.left >= l.left - 0.5 &&
                selectedRect.right <= l.right + 0.5,
              scrollWidth: document.documentElement.scrollWidth,
            };
          });
          await info.attach(`${theme}-${collapsed}-${width}-geometry`, {
            body: JSON.stringify(geometry, null, 2),
            contentType: "application/json",
          });
          if (width === 1280) {
            await page.screenshot({
              path: info.outputPath(`${theme}-${collapsed}-long.png`),
              fullPage: true,
            });
          }
          expect.soft(geometry.actions).toHaveLength(2);
          for (const action of geometry.actions) {
            expect.soft(action.inside, `${action.name} inside strip`).toBe(
              true,
            );
            expect.soft(action.hit, `${action.name} receives pointer`).toBe(
              true,
            );
            expect.soft(action.width).toBe(action.height);
            expect.soft(Math.max(...action.gaps) - Math.min(...action.gaps))
              .toBeLessThanOrEqual(1);
            expect.soft(action.listGap).toBeGreaterThanOrEqual(0);
          }
          expect.soft(geometry.labelWidth).toBeGreaterThan(0);
          expect.soft(geometry.clipped).toBe(true);
          expect.soft(geometry.ellipsis).toBe("ellipsis");
          expect.soft(geometry.nowrap).toBe("nowrap");
          expect.soft(geometry.labelListGap).toBeGreaterThanOrEqual(0);
          expect.soft(geometry.selectedVisible).toBe(true);
          expect.soft(geometry.scrollWidth).toBe(width);
        }
        await page.setViewportSize({ width: 1280, height: 800 });
      }
    }
    // The original failure was a real pointer action intercepted by the rail.
    await state.product("layout.patch", { rightCollapsed: true });
    await expect(page.getByRole("button", {
      name: "Open right panel",
      exact: true,
    })).toBeVisible();
    await tabs.getByRole("button", { name: "Display options", exact: true })
      .click({ timeout: 10_000 });
    await expect(page.locator(".otk-display-menu :popover-open")).toBeVisible();
    await page.keyboard.press("Escape");
    holding = false;
    for (const send of held.splice(0)) send();
    await expect(composer).toHaveValue("Editable while project choices load");
  },
);
