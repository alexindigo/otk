// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";
import { activity, visibleOnScreen } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-default" });
test("sessions.project-memory-precedes-attention-and-defaults-are-visible", {
  tag: ["@sessions", "@attention", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  const directory = state.directory;
  const projectURL = `${state.url}/#project/local/${
    encodeURIComponent(directory)
  }`;
  const remember = async (sessionID?: string) => {
    await state.product("layout.location", {
      sidecarId: "local",
      directory,
      ...(sessionID ? { sessionID } : {}),
    });
  };
  const selected = async (id: string) => {
    await expect(page).toHaveURL(new RegExp(`${id}$`));
    await visibleOnScreen(
      page.locator(
        `[data-open-session=${JSON.stringify(id)}], [data-crumb=${
          JSON.stringify(id)
        }], [data-tab=${JSON.stringify(id)}][aria-selected=true]`,
      ).first(),
    );
  };
  await state.product("layout.patch", { rightCollapsed: true });
  await remember("tstv1-remembered-child");
  await activity(state, "tstv1-urgent-child", "freeze");
  // A cold project route and reload use the same default as a click.
  const stream = await wire(page);
  stream.hold((frame, request) =>
    frame.t === "request.result" && request?.method === "navigation.default"
  );
  try {
    await page.goto(projectURL);
    await expect.poll(() => stream.held.length).toBe(1);
    await expect(page.getByText("Loading sessions...", { exact: true }))
      .toBeVisible();
    await expect(page.getByText("Choose a session", { exact: true }))
      .toHaveCount(0);
  } finally {
    stream.release();
  }
  await selected("tstv1-remembered-child");
  await page.goto(projectURL);
  await page.reload();
  await selected("tstv1-remembered-child");
  await activity(state, "tstv1-urgent-child", "release");
  await expect.poll(() =>
    state.product("navigation.default", {
      directory,
      preferred: "tstv1-remembered-child",
    })
  ).toBe("tstv1-remembered-child");
  // Record real viewing, rather than racing an external preference write against
  // the currently open session's own last-viewed bookkeeping.
  await page.goto(`${state.url}/#/local/tstv1-otk/tstv1-remembered-child`);
  await selected("tstv1-remembered-child");
  await expect.poll(async () =>
    (await state.product("prefs.get", {})).shellLayout.projectLocations?.find((
      p,
    ) => p.directory === directory)?.sessionID
  ).toBe("tstv1-remembered-child");
  await page.goto(`${state.url}/#/local/tstv1-atmosphera`);
  await selected("tstv1-atmosphera");
  await page.locator(
    `.otk-project-row[data-project=${
      JSON.stringify(directory)
    }] .otk-project-open`,
  ).click();
  await selected("tstv1-remembered-child");
  // Same-project clicks must keep the accepted selection despite new attention.
  await activity(state, "tstv1-urgent-child", "freeze");
  await expect.poll(() =>
    state.product("navigation.default", {
      directory,
      preferred: "tstv1-remembered-child",
    })
  ).toBe("tstv1-remembered-child");
  await page.locator(
    `.otk-project-row[data-project=${
      JSON.stringify(directory)
    }] .otk-project-open`,
  ).click();
  await selected("tstv1-remembered-child");
  await activity(state, "tstv1-urgent-child", "release");
  await page.goto(`${state.url}/#/local/tstv1-otk/tstv1-remembered-child`);
  await selected("tstv1-remembered-child");
  await page.reload();
  await selected("tstv1-remembered-child");
  for (
    const [theme, label] of [["otk-dark", "dark"], ["otk-light", "linen"], [
      "otk-light-stone",
      "stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await page.screenshot({
      path: info.outputPath(`sh2-${label}-exact-child.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.goto(`${state.url}/#/local/tstv1-atmosphera`);
  await selected("tstv1-atmosphera");
  await remember();
  // Seed persisted state for a fresh owner. A bookkeeping broadcast must not
  // replace this tab's own accepted destination while it is still alive.
  await page.goto("about:blank");
  await page.goto(projectURL);
  await selected("tstv1-newest-root");
  await expect(page.locator(".otk-selection-notice")).toContainText(
    "No remembered session",
  );
  await page.goto(`${state.url}/#/local/tstv1-atmosphera`);
  await selected("tstv1-atmosphera");
  await remember("tstv1-missing");
  await page.goto("about:blank");
  await page.goto(projectURL);
  await selected("tstv1-newest-root");
  await expect(page.locator(".otk-selection-notice")).toContainText(
    "no longer available",
  );
});
