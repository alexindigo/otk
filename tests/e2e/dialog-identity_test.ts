// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { serve } from "../support/http.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";

async function consumer(run: (browser: Cdp, root: string) => Promise<void>) {
  const root = await fixture(), dist = join(root, "dist");
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.2.0",
      "build",
      "--config",
      "tests/reuse/dialog-consumer/vite.config.ts",
      "--outDir",
      dist,
      "--logLevel",
      "warn",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
  const server = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = join(
        dist,
        new URL(request.url).pathname === "/"
          ? "index.html"
          : new URL(request.url).pathname,
      );
      try {
        return new Response(await Deno.readFile(path), {
          headers: {
            "content-type": path.endsWith(".js")
              ? "text/javascript"
              : path.endsWith(".css")
              ? "text/css"
              : "text/html",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  );
  let browser: Cdp | undefined;
  try {
    browser = await Cdp.launch(root);
    await browser.goto(`http://127.0.0.1:${server.addr.port}`);
    await browser.poll(
      "!!globalThis.dialogTest && !!document.querySelector('#origin')",
    );
    await browser.click("#origin");
    await run(browser, root);
    assertEquals(browser.errors, []);
  } finally {
    await browser?.close();
    await server.shutdown();
  }
}

test("same-type dialog replacement mounts a fresh task form with its own save callback", () =>
  consumer(async (browser) => {
    await browser.evaluate("dialogTest.task('First task')");
    await browser.poll(
      "!!document.querySelector('dialog[open] input[name=taskName]')",
    );
    await browser.fill("input[name=taskName]", "Unsaved first edit");
    await browser.evaluate("dialogTest.task('Second task')");
    await browser.poll(
      "!!document.querySelector('dialog[open] input[name=taskName]')",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('input[name=taskName]').value",
      ),
      "Second task",
      "Replacement retained the old form",
    );
    await browser.fill("input[name=taskName]", "Second edit");
    await browser.click("button[type=submit]");
    await browser.poll("dialogTest.events.length>0");
    assertEquals(await browser.evaluate("dialogTest.events"), [
      "save:Second task:Second edit",
    ]);
    await browser.evaluate("dialogTest.finish()");
    await browser.poll("!document.querySelector('dialog[open]')");
    await browser.poll(
      "document.activeElement===document.querySelector('#origin')",
    );
  }));

test("late task save cannot close its same-type replacement", () =>
  consumer(async (browser, root) => {
    await browser.evaluate("dialogTest.task('Saving task')");
    await browser.poll("!!document.querySelector('dialog[open] input')");
    await browser.click("button[type=submit]");
    await browser.poll(
      "dialogTest.events.includes('save:Saving task:Saving task')",
    );
    await browser.evaluate("dialogTest.task('Replacement task')");
    await browser.poll("!!document.querySelector('dialog[open] input')");
    await browser.evaluate("dialogTest.finish()");
    await browser.poll("dialogTest.events.includes('saved:Saving task')");
    await browser.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('dialog[open] input')?.value",
      ),
      "Replacement task",
      "Old async completion closed or retained the replacement",
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await browser.evaluate(`dialogTest.theme('${theme}')`);
      await browser.poll(
        `document.documentElement.dataset.otkTheme==='${theme}'`,
      );
      await browser.screenshot(join(root, `dialog-${theme}.png`));
    }
    console.info("Dialog replacement screenshots:", root);
    await browser.key("Escape");
    await browser.poll("!document.querySelector('dialog[open]')");
    await browser.poll(
      "document.activeElement===document.querySelector('#origin')",
    );
  }));

test("dialog invocation owns content input, dismiss, teardown and returned close handles across replacements", () =>
  consumer(async (browser) => {
    await browser.evaluate(
      "dialogTest.probe('First').then(handle=>globalThis.firstDialog=handle)",
    );
    await browser.poll("dialogTest.events.includes('mount:First')");
    await browser.evaluate("dialogTest.probe('Second')");
    await browser.poll("!!document.querySelector('dialog[open]')");
    assertEquals(await browser.evaluate("dialogTest.events"), [
      "mount:First",
      "dispose:First",
      "mount:Second",
    ], "Same type did not receive a fresh mounted lifetime");
    assertEquals(
      await browser.evaluate("dialogTest.inputs[0]()"),
      "First",
      "Retired input follows the current invocation",
    );
    await browser.evaluate("firstDialog.close(); dialogTest.closes[0]()");
    await browser.poll(
      "document.querySelector('dialog[open]')?.getAttribute('aria-label')==='Second'",
    );
    await browser.key("Escape");
    await browser.poll("dialogTest.events.includes('dismiss:Second')");
    assertEquals(
      await browser.evaluate("!!document.querySelector('dialog[open]')"),
      true,
      "Feature dismissal owns its close decision",
    );
    await browser.evaluate("dialogTest.task('Different type')");
    await browser.poll("!!document.querySelector('dialog[open] input')");
    await browser.evaluate("dialogTest.closes[1](); firstDialog.close()");
    assertEquals(
      await browser.evaluate(
        "document.querySelector('dialog[open] input')?.value",
      ),
      "Different type",
    );
    await browser.evaluate("dialogTest.close()");
    await browser.poll("!document.querySelector('dialog[open]')");
  }));
