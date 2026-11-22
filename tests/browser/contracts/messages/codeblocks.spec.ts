// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { permissionSource } from "../../../fixtures/codeblock-examples.ts";

test.use({
  profile: "contract-messages-codeblocks",
  viewport: { width: 1280, height: 1600 },
  launchOptions: {
    args: ["--host-resolver-rules=MAP otk.test 127.0.0.1", "--no-proxy-server"],
  },
});
function httpUrl(base: string) {
  const url = new URL(base);
  url.hostname = "otk.test";
  url.hash = "/local/tstv1-core";
  return url.href;
}
const noWorker = () => {
  globalThis.Worker = class {
    constructor() {
      throw new Error("Worker constructor fixture");
    }
  } as unknown as typeof Worker;
};

test("messages.codeblocks-original-sources-in-every-theme", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }, info) => {
  await page.goto(httpUrl(state.url));
  const first = page.locator('[data-message="codeblock-0"]');
  const second = page.locator('[data-message="codeblock-1"]');
  await expect(first.locator(".otk-code code")).toHaveJSProperty(
    "textContent",
    permissionSource,
  );
  await expect(second).toContainText("Permission denied");
  await expect(second).toContainText("$ ls -la");
  await expect(second.locator(".otk-code-content")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  for (
    const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
      "otk-light-stone",
      "stone",
    ]]
  ) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await page.screenshot({
      path: info.outputPath(`codeblock-${name}.png`),
      fullPage: true,
    });
  }
});

test("messages.codeblocks-unlabelled-source-needs-no-worker", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await page.addInitScript(noWorker);
  await page.goto(httpUrl(state.url));
  expect(await page.evaluate(() => isSecureContext)).toBe(false);
  const code = page.locator('[data-message="codeblock-0"] .otk-code');
  await expect(code.locator("code")).toHaveJSProperty(
    "textContent",
    permissionSource,
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("messages.codeblocks-stray-EOF-fence-is-not-paragraph-text", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(httpUrl(state.url));
  await expect(page.locator(".otk-text p").filter({ hasText: "```" }))
    .toHaveCount(0);
  await expect(page.locator(".otk-code-content")).toHaveCount(1);
  // The original native source really has an empty fence pair. Its shell text
  // must remain visible, not be guessed into a different block or discarded.
  const original = page.locator('[data-message="codeblock-1"]');
  await expect(original).toContainText("Permission denied");
  await expect(original).toContainText("$ ls -la");
  await expect(original.locator(".otk-code-content")).toHaveCount(0);
});

test.describe("syntax enhancement", () => {
  test.use({ profile: "contract-messages-highlight" });
  const source = "const stableValue: number = 7;";
  test("messages.codeblocks-malformed-tokens-cannot-replace-source", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await page.addInitScript(() => {
      const Native = Worker;
      Reflect.set(globalThis, "malformedTokens", 0);
      globalThis.Worker = class extends Native {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener("message", (event) => {
            const data = event.data;
            if (!data.tokens?.length || data.malformed) return;
            event.stopImmediatePropagation();
            Reflect.set(
              globalThis,
              "malformedTokens",
              Number(Reflect.get(globalThis, "malformedTokens")) + 1,
            );
            this.dispatchEvent(
              new MessageEvent("message", {
                data: {
                  ...data,
                  malformed: true,
                  tokens: data.tokens.map((token: { content: string }) => ({
                    ...token,
                    content: token.content.replace(/[^\r\n]/g, " "),
                  })),
                },
              }),
            );
          }, true);
        }
      };
    });
    await page.goto(httpUrl(state.url));
    await expect.poll(() =>
      page.evaluate(() => Reflect.get(globalThis, "malformedTokens"))
    ).toBeGreaterThan(0);
    await page.evaluate(() =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
    );
    await expect(page.locator(".otk-code code")).toHaveJSProperty(
      "textContent",
      source,
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
  test("messages.codeblocks-worker-construction-cannot-remove-source", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await page.addInitScript(noWorker);
    await page.goto(httpUrl(state.url));
    await expect(page.locator(".otk-code code")).toHaveJSProperty(
      "textContent",
      source,
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
  test(
    "messages.codeblocks-worker-failure-retains-exact-source-without-red-feedback",
    { tag: ["@messages", "@contracts"] },
    async ({ isolatedState: state, page }) => {
      const diagnostics: string[] = [];
      page.on("console", (message) => diagnostics.push(message.text()));
      // Exercise the real module worker and native engine loader. The HTTP refusal
      // has a real reason, rather than substituting a made-up exception downstream.
      await page.route(
        "**/onig-*.wasm",
        (route) => route.fulfill({ status: 503, body: "engine unavailable" }),
      );
      await page.goto(httpUrl(state.url));
      await expect.poll(() =>
        diagnostics.some((line) => line.includes("Highlight engine asset: 503"))
      ).toBe(true);
      await expect(page.locator(".otk-code code")).toHaveJSProperty(
        "textContent",
        source,
      );
      await expect(page.locator(".otk-messages")).not.toContainText(
        "Highlighting source failed",
      );
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(
        diagnostics.some((line) =>
          line.includes("Syntax highlighting diagnostic:")
        ),
      ).toBe(true);
    },
  );
});
