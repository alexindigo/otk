// SPDX-License-Identifier: LGPL-3.0-only
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "../../fixtures/evidence.ts";
import type { TestInfo } from "@playwright/test";

async function startPeers(info: TestInfo) {
  const version = String(
    info.project.metadata.nativeVersion ??
      info.project.name.replace(/^oc-/, ""),
  );
  const child = spawn("deno", [
    "run",
    "-A",
    "tests/support/server-discovery-fixture.ts",
  ], {
    cwd: resolve(process.cwd(), "../.."),
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          key.startsWith("OTK_TEST_") ||
          ["PATH", "TMPDIR", "DENO_DIR", "HOME", "PLAYWRIGHT_BROWSERS_PATH"]
            .includes(key)
        ),
      ),
      OTK_TEST_VERSION: version,
      OTK_TEST_OPENCODE: `/opt/otk-test/opencode/${version}/opencode`,
      OTK_TEST_PROVIDER_CACHE:
        `/opt/otk-test/provider-cache/opencode-${version}`,
      OTK_TEST_STACK_ID: `sd3-${randomUUID()}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (bytes) => {
    log += String(bytes);
  });
  const closed = new Promise<number | null>((yes, no) => {
    child.once("close", yes);
    child.once("error", no);
  });
  const ready = new Promise<Record<string, string>>((yes, no) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith("SD3 ")) yes(JSON.parse(line.slice(4)));
      else log += line + "\n";
    });
    void closed.then(
      (code) => no(new Error(`Discovery peers exited ${code}: ${log}`)),
      no,
    );
  });
  return {
    endpoints: await ready,
    async close() {
      child.stdin.end();
      expect(await closed, log).toBe(0);
    },
  };
}

test("transport.server-discovery-outcomes-and-cancel", {
  tag: ["@transport", "@isolated"],
}, async ({ page }, info) => {
  test.setTimeout(240_000);
  const peers = await startPeers(info);
  try {
    const endpoints = peers.endpoints;
    await page.goto(endpoints.local);
    await expect(page.locator(".otk-welcome")).toBeVisible();
    await page.locator(".otk-settings-entry").click();
    const settings = page.locator(".otk-settings");
    const url = settings.getByLabel("Base URL", { exact: true });
    const label = settings.getByLabel("Label", { exact: true });
    const steps = settings.getByRole("list", { name: "Server discovery" });
    const capture = async (state: string) => {
      for (
        const [theme, bg] of [
          ["otk-dark", "#1a1c1e"],
          ["otk-light", "#f4eee3"],
          ["otk-light-stone", "#f5f3ef"],
        ]
      ) {
        await page.keyboard.press("Control+k");
        await page.locator("input[name=command-search]").fill("Choose theme");
        await page.locator('[data-command="theme.open"]').click();
        await page.locator(`[data-theme-choice="${theme}"]`).click();
        await page.getByRole("button", { name: "Save theme", exact: true })
          .click();
        // Theme paint is a preview, not save completion. Background native
        // inputs cannot take focus until the modal releases its lifetime.
        await expect(page.getByRole("dialog", { name: "Theme", exact: true }))
          .toHaveCount(0);
        await expect(page.locator("html")).toHaveAttribute(
          "data-otk-theme",
          theme,
        );
        await expect.poll(() =>
          page.locator("html").evaluate((node) =>
            getComputedStyle(node).getPropertyValue("--otk-bg")
          )
        ).toBe(bg);
        const control = settings.getByRole("button", {
          name: state === "running" ? "Cancel" : "Add server",
          exact: true,
        });
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport();
        await page.evaluate(() => document.fonts.ready);
        await info.attach(`sd3-${state}-${theme}`, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      }
    };
    const add = async (name: string) => {
      await url.fill(endpoints[name]);
      await label.fill(name);
      await settings.getByRole("button", { name: "Add server", exact: true })
        .click();
    };
    for (
      const [name, reason] of [
        ["refused", "could not connect"],
        ["foreign", "HTTP 401"],
        ["native", ""],
        ["blocked", "[server].origins"],
      ] as const
    ) {
      const expected = name === "native"
        ? await page.evaluate(async (target) => {
          try {
            const reply = await fetch(target + "/api/discovery", {
              credentials: "omit",
            });
            return `HTTP ${reply.status}`;
          } catch {
            return "browser could not connect";
          }
        }, endpoints.native)
        : reason;
      await add(name);
      await expect(steps.getByRole("alert")).toContainText(expected);
      await expect(steps.getByRole("alert")).toContainText(endpoints[name]);
      await expect(steps).not.toContainText("Could not finish this action");
      await expect(url).toBeEditable();
      await expect(
        settings.getByRole("button", { name: "Cancel", exact: true }),
      ).toHaveCount(0);
      expect(
        await steps.locator("li").evaluateAll((rows) =>
          rows.every((row) => row.querySelectorAll("p").length === 1)
        ),
      ).toBe(true);
      await info.attach(`discovery-${name}`, {
        body: await steps.innerText(),
        contentType: "text/plain",
      });
    }
    await expect(steps).toContainText(new URL(endpoints.local).origin);
    await capture("origin-result");
    await add("held");
    await expect(settings.getByRole("button", { name: "Cancel", exact: true }))
      .toBeVisible();
    await expect(url).toBeEditable();
    await url.fill(endpoints.allowed); // the captured held request stays owned separately
    await expect(steps).toContainText("Connecting");
    await expect(steps.locator("li span")).not.toHaveText("0.0s");
    await capture("running");
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(steps).toContainText("was cancelled");
    await add("held");
    await expect(settings.getByRole("button", { name: "Cancel", exact: true }))
      .toBeVisible();
    await settings.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(steps).toContainText("was cancelled");
    for (
      const [name, result] of [["allowed", "server ready"], [
        "setup",
        "Setup required",
      ], ["password", "Sign-in required"]]
    ) {
      await add(name);
      await expect(steps).toContainText(result);
      await expect(steps.locator("li")).toHaveCount(3);
      expect(
        await steps.locator("li").evaluateAll((rows) =>
          rows.every((row) => row.querySelectorAll("p").length === 1)
        ),
      ).toBe(true);
      await expect(
        settings.locator(".otk-sidecar-card").filter({
          has: page.getByRole("heading", { name, exact: true }),
        }),
      ).toBeVisible();
    }
    const password = settings.locator(".otk-sidecar-card").filter({
      has: page.getByRole("heading", { name: "password", exact: true }),
    });
    await password.getByLabel("Username", { exact: true }).fill("tester");
    await password.getByLabel("Password", { exact: true }).fill("secret");
    await password.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(password.locator("[data-connection]")).toHaveText("connected");
    // Full Settings frames use existing primitives, not the pending MK3 visual design.
    await capture("sign-in-result");
    await info.attach("discovery-results", {
      body: await steps.innerText(),
      contentType: "text/plain",
    });
    await page.goto(endpoints.local.replace("127.0.0.1", "localhost"));
    await expect(page.locator(".otk-welcome")).toBeVisible();
    await page.locator(".otk-settings-entry").click();
    await url.fill(endpoints.password);
    await label.fill("cross-site");
    await settings.getByRole("button", { name: "Add server", exact: true })
      .click();
    await expect(steps).toContainText("Sign-in required");
    const crossSite = settings.locator(".otk-sidecar-card").filter({
      has: page.getByRole("heading", { name: "cross-site", exact: true }),
    });
    await crossSite.getByLabel("Username", { exact: true }).fill("tester");
    await crossSite.getByLabel("Password", { exact: true }).fill("secret");
    await crossSite.getByRole("button", { name: "Log in", exact: true })
      .click();
    await expect(crossSite.getByRole("alert")).toContainText(
      "OTK accepted sign-in, but this page is still not authenticated",
    );
    await expect(crossSite.getByRole("alert")).toContainText("cookie settings");
    await expect(crossSite.locator("[data-connection]")).toHaveText(
      "login required",
    );
  } finally {
    await page.close();
    await peers.close();
  }
});

test(
  "transport.discovery-remount-borrows-pending-cancel-and-retains-edited-fields",
  {
    tag: ["@transport", "@isolated"],
  },
  async ({ page }, info) => {
    test.setTimeout(180_000);
    const peers = await startPeers(info), e = peers.endpoints;
    try {
      await page.goto(e.local);
      await expect(page.locator(".otk-welcome")).toBeVisible();
      await page.locator(".otk-settings-entry").click();
      const settings = page.locator(".otk-settings"),
        url = settings.getByLabel("Base URL", { exact: true }),
        label = settings.getByLabel("Label", { exact: true });
      const counters = async () =>
        await (await page.request.get(e.counters)).json() as {
          held: number;
          aborted: number;
        };
      for (let attempt = 1; attempt <= 2; attempt++) {
        await url.fill(e.held);
        await label.fill("Captured target " + attempt);
        await settings.getByRole("button", { name: "Add server", exact: true })
          .click();
        await expect.poll(async () => (await counters()).held).toBe(attempt);
        await url.fill(e.allowed);
        await label.fill("Retained next input " + attempt);
        await settings.getByRole("button", {
          name: "Close settings",
          exact: true,
        }).click();
        await page.locator(".otk-settings-entry").click();
        await expect(settings.getByRole("list", { name: "Server discovery" }))
          .toContainText("Connecting");
        await expect(settings).toContainText("Checking OTK at " + e.held);
        await expect(url).toHaveValue(e.allowed);
        await expect(label).toHaveValue("Retained next input " + attempt);
        const cancel = settings.getByRole("button", {
          name: "Cancel",
          exact: true,
        });
        await expect(cancel).toBeEnabled();
        await cancel.click();
        await expect.poll(async () => (await counters()).aborted).toBe(attempt);
        await expect(settings.getByRole("list", { name: "Server discovery" }))
          .toContainText("was cancelled");
        await expect(url).toHaveValue(e.allowed);
        await expect(label).toHaveValue("Retained next input " + attempt);
      }
    } finally {
      await page.close();
      await peers.close();
    }
  },
);

test(
  "transport.saved-remote-first-contact-failure-recovers-before-receiving-remote-policy",
  {
    tag: ["@transport", "@isolated"],
  },
  async ({ page }, info) => {
    test.setTimeout(180_000);
    const peers = await startPeers(info), e = peers.endpoints;
    let reads = 0;
    try {
      await page.addInitScript((baseUrl) =>
        localStorage.setItem(
          "otk.sidecars",
          JSON.stringify([{ id: "saved", baseUrl, label: "Saved remote" }]),
        ), e.allowed);
      await page.route(e.allowed + "/api/session", async (route) => {
        reads++;
        if (reads === 1) {
          await route.abort("connectionrefused");
        } else await route.continue();
      });
      await page.goto(e.local);
      await expect(page.locator(".otk-welcome")).toBeVisible();
      await page.locator(".otk-settings-entry").click();
      const card = page.locator(".otk-sidecar-card").filter({
        has: page.getByRole("heading", { name: "Saved remote", exact: true }),
      });
      await expect(card.locator("[data-connection]")).toHaveText("connected");
      expect(reads).toBeGreaterThanOrEqual(2);
    } finally {
      await page.close();
      await peers.close();
    }
  },
);

test(
  "transport.failed-login-session-check-retains-reconnect-not-a-stale-cookie-diagnosis",
  {
    tag: ["@transport", "@isolated"],
  },
  async ({ page }, info) => {
    test.setTimeout(180_000);
    const peers = await startPeers(info), e = peers.endpoints;
    let fail = false, failed = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => release = resolve);
    try {
      await page.goto(e.local);
      await expect(page.locator(".otk-welcome")).toBeVisible();
      await page.locator(".otk-settings-entry").click();
      const settings = page.locator(".otk-settings");
      await settings.getByLabel("Base URL", { exact: true }).fill(e.password);
      await settings.getByLabel("Label", { exact: true }).fill(
        "Follow-up failure",
      );
      await settings.getByRole("button", { name: "Add server", exact: true })
        .click();
      const card = settings.locator(".otk-sidecar-card").filter({
        has: page.getByRole("heading", {
          name: "Follow-up failure",
          exact: true,
        }),
      });
      await expect(card.locator("[data-connection]")).toHaveText(
        "login required",
      );
      await page.route(e.password + "/api/session", async (route) => {
        if (!fail) return await route.continue();
        if (++failed === 1) return await route.abort("connectionrefused");
        await released;
        await route.continue();
      });
      fail = true;
      await card.evaluate((node) => {
        const trace: string[] = [];
        const observer = new MutationObserver(() =>
          trace.push(node.textContent ?? "")
        );
        observer.observe(node, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        (window as unknown as {
          loginTrace: { trace: string[]; observer: MutationObserver };
        }).loginTrace = { trace, observer };
      });
      await card.getByLabel("Username", { exact: true }).fill("tester");
      await card.getByLabel("Password", { exact: true }).fill("secret");
      await card.getByRole("button", { name: "Log in", exact: true }).click();
      // Retry entry proves the failed attempt's continuations and feedback have
      // drained, rather than sampling the transient reconnect before login resumes.
      await expect.poll(() => failed).toBeGreaterThanOrEqual(2);
      const trace = await page.evaluate(() => {
        const value = (window as unknown as {
          loginTrace: { trace: string[]; observer: MutationObserver };
        }).loginTrace;
        value.observer.disconnect();
        return value.trace;
      });
      expect(trace.join("\n")).not.toContain(
        "OTK accepted sign-in, but this page is still not authenticated",
      );
      expect(trace.join("\n")).not.toContain("cookie settings");
      await expect(card.locator("[data-connection]")).toHaveText(
        "reconnecting",
      );
      await expect(card).not.toContainText(
        "OTK accepted sign-in, but this page is still not authenticated",
      );
      await expect(card).not.toContainText("cookie settings");
      fail = false;
      release();
      await expect(card.locator("[data-connection]")).toHaveText("connected");
    } finally {
      release();
      await page.close();
      await peers.close();
    }
  },
);
