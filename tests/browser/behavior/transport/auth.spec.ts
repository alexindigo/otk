// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { expectPublicSession } from "../../pages/auth.ts";

test(
  "transport.setup-password-cookie",
  { tag: ["@transport", "@isolated"] },
  async ({ isolatedState: state, page, browser }) => {
    const { url } = await state.controller.call<{ url: string }>("auxiliary", {
      lease: state.lease.lease,
      kind: "setup",
    });
    await page.goto(url);
    await expect(page.locator("select[name=type]")).toHaveValue("password");
    await expect(page.locator(".otk-app [disabled]")).toHaveCount(0);
    await page.locator("input[name=username]").fill("geometry-user");
    await page.locator("input[name=password]").fill("geometry-password");
    await page.locator(".otk-auth-view button[type=submit]").click();
    await expect(page.locator(".otk-auth-view")).toHaveCount(0);
    await expect(page.locator(".otk-corner-right")).toBeEnabled();
    expect(
      (await page.context().cookies(url)).some((cookie) => cookie.httpOnly),
    ).toBe(true);
    const context = await state.newContext(browser),
      fresh = await context.newPage();
    await fresh.goto(url);
    await fresh.locator("input[name=username]").fill("geometry-user");
    await fresh.locator("input[name=password]").fill("geometry-password");
    await fresh.locator(".otk-auth-view button[type=submit]").click();
    await expect(fresh.locator(".otk-auth-view")).toHaveCount(0);
    await expect(fresh.locator(".otk-corner-right")).toBeEnabled();
    expect((await context.cookies(url)).some((cookie) => cookie.httpOnly)).toBe(
      true,
    );
    const open = await state.controller.call<{ url: string }>("auxiliary", {
      lease: state.lease.lease,
      kind: "open-setup",
    });
    await page.goto(open.url);
    await page.locator("select[name=type]").selectOption("none");
    await page.locator(".otk-auth-view button[type=submit]").click();
    await expect(page.locator(".otk-auth-view")).toHaveCount(0);
    await expect(page.locator(".otk-corner-right")).toBeEnabled();
    await expect(page.locator(".otk-server-status[data-connection=local]"))
      .toHaveAttribute("title", /: connected;/);
    await expectPublicSession(context.request, open.url, {
      authenticated: true,
      setupRequired: false,
      authType: "none",
    }, ["geometry-password"]);
  },
);

test(
  "transport.password-login",
  { tag: ["@transport", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string; directory: string }>(
      "/session",
      "POST",
      {
        title: "Password session",
      },
    );
    const { url } = await state.controller.call<{ url: string }>("auxiliary", {
      lease: state.lease.lease,
      kind: "password",
    });
    await page.goto(url);
    await page.locator("input[name=username]").fill("tester");
    await page.locator("input[name=password]").fill("wrong");
    await page.locator(".otk-auth-view button[type=submit]").click();
    await expect(page.locator(".otk-auth-view [role=alert]")).toHaveText(
      "Check your username and password",
    );
    await expect(page.locator("input[name=password]")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page.locator(".otk-auth-view [role=alert]")).toHaveCount(1);
    await page.locator("input[name=password]").fill("secret");
    await page.locator(".otk-auth-view button[type=submit]").click();
    await expect(page.locator(".otk-auth-view")).toHaveCount(0);
    await expect(page.locator(".otk-server-status[data-connection=local]"))
      .toHaveAttribute("title", /: connected;/);
    await page.locator(
      `[data-project="${session.directory}"] .otk-project-open`,
    ).click();
    await page.getByRole("button", { name: "Open right panel", exact: true })
      .click();
    await page.getByRole("complementary", { name: "Right panel", exact: true })
      .getByRole("tab", { name: "Sessions", exact: true }).click();
    await expect(page.locator(`[data-session="${session.id}"]`)).toBeVisible();
    await expect(page.locator("[data-session]")).toHaveCount(1);
  },
);

test(
  "transport.authenticated-remote",
  { tag: ["@transport", "@isolated"] },
  async ({ isolatedState: state, page }, info) => {
    await state.native("/session", "POST", { title: "First host" });
    const remote = await state.controller.call<
      { url: string; session: { id: string } }
    >("auxiliary", { lease: state.lease.lease, kind: "remote-password" });
    await page.goto(state.url);
    await page.locator(".otk-settings-entry").click();
    await page.locator("input[name=url]").fill(remote.url);
    await page.locator("input[name=label]").fill("Remote agent");
    await page.locator(".otk-settings-content > .otk-form button[type=submit]")
      .click();
    const card = page.locator(
      "[data-settings-sidecar]:not([data-settings-sidecar=local])",
    );
    await card.locator("input[name=username]").fill("tester");
    await card.locator("input[name=password]").fill("secret");
    await card.locator("button[type=submit]").click();
    await expect(page.locator(".otk-sidecar-card [data-connection]"))
      .toHaveText(["connected", "connected"]);
    await page.locator(".otk-view-header button").click();
    await page.locator(
      `[data-server]:not([data-server=local]) .otk-project-open`,
    ).click();
    await page.getByRole("button", { name: "Open right panel", exact: true })
      .click();
    await page.getByRole("complementary", { name: "Right panel", exact: true })
      .getByRole("tab", { name: "Sessions", exact: true }).click();
    await page.locator(`[data-session="${remote.session.id}"]`).click();
    await state.controller.call("queueScript", {
      lease: state.lease.lease,
      chunks: ["Reply from the second sidecar"],
      target: "remote",
    });
    await page.locator("textarea[name=prompt]").fill("Remote prompt");
    await page.locator("textarea[name=prompt]").press("Enter");
    await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
      "Reply from the second sidecar",
    );
    expect(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem("otk.sidecars")!)
      ),
    ).toEqual([
      expect.objectContaining({ baseUrl: remote.url, label: "Remote agent" }),
    ]);
    await page.reload();
    await expect(page.locator(".otk-project-inbox [data-project]")).toHaveCount(
      info.project.name === "oc-2.2.6" ? 3 : 2,
    );
    await expect(page.locator("[data-session]")).toHaveCount(1);
    await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
      "Reply from the second sidecar",
    );
  },
);
