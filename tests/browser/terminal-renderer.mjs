// SPDX-License-Identifier: LGPL-3.0-only
// Run only in the assigned guest, after building the terminal-browser fixture.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";

const root = resolve(process.argv[2]);
const artifacts = process.argv[3];
if (artifacts) await mkdir(artifacts, { recursive: true });
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://fixture").pathname;
  const path = resolve(root, "." + (name === "/" ? "/index.html" : name));
  if (!path.startsWith(root + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(path);
    response.setHeader(
      "content-type",
      path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".css")
        ? "text/css"
        : path.endsWith(".wasm")
        ? "application/wasm"
        : path.endsWith(".woff2")
        ? "font/woff2"
        : "text/html",
    );
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
const failures = [];
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1400 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const test of ["hidden", "links", "conceal"]) {
    await page.goto(url);
    await page.waitForFunction(() =>
      document.documentElement.dataset.ready === "true"
    );
    try {
      if (test === "hidden") {
        const [measured, hidden] = await page.evaluate(() =>
          globalThis.terminalFixture.hiddenCheckpoint()
        );
        assert(measured.includes("hidden-checkpoint"));
        assert.equal(
          hidden,
          measured,
          "hidden checkpoint must parse on the canonical grid",
        );
        if (artifacts) {
          await page.screenshot({
            path: resolve(artifacts, "hidden-grid.png"),
            fullPage: true,
          });
        }
      } else if (test === "conceal") {
        const canvas = page.locator("#visible canvas");
        await page.evaluate(() => globalThis.terminalFixture.concealed("X"));
        const concealed = await canvas.evaluate((element) =>
          element.toDataURL()
        );
        await page.evaluate(() => globalThis.terminalFixture.concealed(" "));
        assert.equal(
          await canvas.evaluate((element) => element.toDataURL()),
          concealed,
          "a block cursor must not reveal a concealed glyph",
        );
      } else {
        await page.evaluate(() => globalThis.terminalFixture.prepareLink());
        const canvas = page.locator("#visible canvas");
        await page.waitForFunction(() =>
          document.querySelector("#visible canvas").getContext("2d")
            .getImageData(4, 4, 100, 25).data.some((byte, index) =>
              index % 4 !== 3 && byte > 100
            )
        );
        const previous = await canvas.evaluate((element) =>
          element.toDataURL()
        );
        if (artifacts) {
          await page.screenshot({
            path: resolve(artifacts, "link-a.png"),
            fullPage: true,
          });
        }
        const metrics = await canvas.evaluate((element) => ({
          box: element.getBoundingClientRect().toJSON(),
          width: element.getContext("2d").measureText("M").width,
        }));
        await page.evaluate(() => globalThis.terminalFixture.pendingLink());
        assert.equal(
          await canvas.evaluate((element) => element.toDataURL()),
          previous,
          "synchronized update must retain the painted A frame",
        );
        await page.mouse.click(
          metrics.box.x + 4 + metrics.width / 2,
          metrics.box.y + 10,
        );
        assert(
          !(await page.evaluate(() => globalThis.terminalFixture.links))
            .includes("https://b.test/"),
          "painted A must not activate live B",
        );
        await page.evaluate(() => globalThis.terminalFixture.finishLink());
        await page.waitForFunction(
          (previous) =>
            document.querySelector("#visible canvas").toDataURL() !== previous,
          previous,
        );
        await page.mouse.click(
          metrics.box.x + 4 + metrics.width * 4.5,
          metrics.box.y + 10,
        );
        await page.waitForFunction(() =>
          globalThis.terminalFixture.links.includes("https://b.test/")
        );
        if (artifacts) {
          await page.screenshot({
            path: resolve(artifacts, "link-b.png"),
            fullPage: true,
          });
        }
      }
      console.log(JSON.stringify({ test, outcome: "passed" }));
    } catch (error) {
      failures.push({ test, error: error.message });
      console.error(
        JSON.stringify({ test, outcome: "failed", error: error.message }),
      );
    } finally {
      await page.evaluate(() => globalThis.terminalFixture.dispose());
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
