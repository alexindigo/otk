// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page, type TestInfo } from "@playwright/test";

/** Read-only rendered probes, shared by focused contracts and the complete theme sweep. */
export async function auditUiRules(
  page: Page,
  info: Pick<TestInfo, "attach">,
  state: string,
) {
  const values = await page.evaluate((state) => {
    const regions: Record<string, string> = {
      sidebar: ".otk-project-inbox,.otk-right-rail",
      tabs: ".otk-task-strip",
      crumbs: ".otk-breadcrumb-row",
      status: ".otk-shell-progress",
      transcript: ".otk-messages",
      composer: ".otk-composer,.otk-prompt",
      docks: ".otk-takeover",
      toasts: ".otk-toasts",
      panels: ".otk-panel-content",
      menus: ":popover-open",
      dialogs: "dialog[open]",
      panelViews: ".otk-panel-icons,.otk-panel-rail-icons",
      components: ".theme-pane-body,.theme-region",
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect(), c = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && c.visibility !== "hidden" &&
        !el.closest("[hidden],[inert]");
    };
    return Object.entries(regions).flatMap(([region, selector]) =>
      Array.from(document.querySelectorAll(selector)).filter(visible).map(
        (root) => {
          const controls = Array.from(root.querySelectorAll<HTMLElement>(
            "button,input,select,textarea,[role=tab],[role=menuitem]",
          ));
          const labels = Array.from(root.querySelectorAll(
            ".otk-control-label,.otk-crumb-title,.otk-row-title,.otk-tabs-project,.otk-surface-title-text",
          )).filter(visible).filter((el) =>
            !el.querySelector("input,textarea")
          );
          const wrapping = labels.map((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const r = range.getBoundingClientRect(), c = getComputedStyle(el);
            return {
              label: el.textContent,
              height: r.height,
              line: parseFloat(c.lineHeight),
              nowrap: c.whiteSpace === "nowrap",
            };
          });
          const rings = [
            root,
            ...Array.from(root.querySelectorAll(":focus-visible")),
          ]
            .filter((el) => el.matches(":focus-visible")).map((el) => {
              const r = el.getBoundingClientRect(), c = getComputedStyle(el);
              return {
                tag: el.tagName,
                visible: visible(el),
                width: r.width,
                height: r.height,
                outline: parseFloat(c.outlineWidth),
                style: c.outlineStyle,
                shadow: c.boxShadow,
                control: el.matches(
                  "button,input,select,textarea,summary,a[href],[role=tab],[role=menuitem],[role=separator],[data-otk-focus=content]",
                ),
              };
            });
          const icons = Array.from(
            root.querySelectorAll<HTMLElement>(
              ".otk-icon-button,.otk-send-button,.otk-inbox-search,.otk-server-status,.otk-inactive-toggle,.otk-discovered-toggle,.otk-session-search",
            ),
          ).filter(visible)
            .filter((el) => el.querySelector("svg,.otk-connection-light"))
            .map((el) => {
              const r = el.getBoundingClientRect(),
                i = el.querySelector("svg,.otk-connection-light")!
                  .getBoundingClientRect();
              return {
                label: el.getAttribute("aria-label") ?? el.textContent,
                gaps: el.matches(".otk-icon-button,.otk-send-button")
                  ? [
                    i.left - r.left,
                    r.right - i.right,
                    i.top - r.top,
                    r.bottom - i.bottom,
                  ]
                  : [i.left - r.left, i.top - r.top, r.bottom - i.bottom],
              };
            });
          const rect = root.getBoundingClientRect();
          const slots = Array.from(
            root.querySelectorAll<HTMLElement>(
              ".otk-control-icon,.otk-control-accessory",
            ),
          ).filter(visible).map((el) => {
            const r = el.getBoundingClientRect(), c = getComputedStyle(el);
            const icon = el.firstElementChild?.getBoundingClientRect();
            return {
              width: r.width,
              height: r.height,
              position: c.position,
              transform: c.transform,
              centre: icon
                ? [
                  Math.abs(icon.x + icon.width / 2 - r.x - r.width / 2),
                  Math.abs(icon.y + icon.height / 2 - r.y - r.height / 2),
                ]
                : [],
            };
          });
          return {
            region,
            theme: document.documentElement.dataset.otkTheme,
            state,
            box: [rect.x, rect.y, rect.width, rect.height],
            controls: controls.filter(visible).length,
            disabled: controls.filter((el) =>
              el.matches(":disabled,[aria-disabled=true]")
            ).length,
            staticHints:
              Array.from(root.querySelectorAll("kbd")).filter(visible).filter(
                (el) =>
                  !el.closest(".otk-palette-list,.otk-keys-list"),
              ).length,
            wrapping,
            rings,
            icons,
            slots,
            toggles: controls.filter((el) =>
              el.classList.contains("otk-toggle")
            ).map((el) => ({
              on: el.getAttribute("aria-pressed") === "true",
              classOn: el.classList.contains("is-on"),
              selection: el.hasAttribute("data-otk-selection"),
            })),
            stateInline: controls.filter((el) =>
              ["opacity", "color", "visibility", "display"].some((k) =>
                el.style.getPropertyValue(k)
              )
            ).map((el) => ({
              label: el.getAttribute("aria-label"),
              style: el.getAttribute("style"),
            })),
            shadows: Array.from(
              new Set(
                [root, ...controls.filter(visible)].map((el) =>
                  getComputedStyle(el).boxShadow
                ),
              ),
            ),
          };
        },
      )
    );
  }, state);
  await info.attach("ui-rules-" + state, {
    body: JSON.stringify(values, null, 2),
    contentType: "application/json",
  });
  const failures = values.flatMap((region) => [
    ...(region.disabled
      ? [{ region: region.region, rule: 3, count: region.disabled }]
      : []),
    ...(region.staticHints
      ? [{ region: region.region, rule: 4, count: region.staticHints }]
      : []),
    ...region.stateInline.map((value) => ({
      region: region.region,
      rule: 10,
      value,
    })),
    ...region.icons.filter((icon) =>
      Math.max(...icon.gaps) - Math.min(...icon.gaps) > 1
    ).map((value) => ({ region: region.region, rule: 1, value })),
    ...region.slots.filter((slot) =>
      Math.abs(slot.width - slot.height) > 1 || slot.position !== "static" ||
      slot.transform !== "none" || slot.centre.some((delta) => delta > 0.5)
    ).map((value) => ({ region: region.region, rule: 2, value })),
    ...region.wrapping.filter((label) =>
      !label.nowrap || !(label.height <= label.line + 1)
    ).map((value) => ({ region: region.region, rule: 5, value })),
    ...region.toggles.filter((toggle) =>
      toggle.classOn !== toggle.on || toggle.selection
    ).map((value) => ({ region: region.region, rule: 6, value })),
    ...region.rings.filter((ring) =>
      ring.outline > 0 && ring.style !== "none" &&
      (!ring.visible || !ring.control)
    ).map((value) => ({ region: region.region, rule: 7, value })),
  ]);
  expect.soft(failures, "UI rules: " + state).toEqual([]);
  return values;
}
