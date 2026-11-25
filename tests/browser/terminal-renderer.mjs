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
  for (
    const test of [
      "hidden",
      "links",
      "conceal",
      "tabs",
      "paste-hidden",
      "paste-native-first",
      "paste-read-first",
      "paste-mac",
      "rtl",
      "scrollbar",
      "scrollbar-accessibility",
      "hover",
      "selection-blink",
      "composition-hidden",
      "composition-visible",
      "composition-reopen",
      "input-hidden",
      "input-reopen",
      "paste-hidden-reopen",
      "hidden-reports",
    ]
  ) {
    await page.goto(url);
    await page.waitForFunction(() =>
      document.documentElement.dataset.ready === "true"
    );
    try {
      if (test.startsWith("composition-")) {
        await page.evaluate(() =>
          globalThis.terminalFixture.compositionStart("draft")
        );
        if (test !== "composition-visible") {
          await page.evaluate(() => globalThis.terminalFixture.hide());
        }
        if (test === "composition-reopen") {
          await page.evaluate(() => globalThis.terminalFixture.show());
        }
        await page.evaluate(() => {
          globalThis.terminalFixture.compositionEnd("IME-commit");
          globalThis.terminalFixture.textInput(
            "IME-commit",
            "insertFromComposition",
          );
        });
        assert.deepEqual(
          await page.evaluate(() => globalThis.terminalFixture.input),
          test === "composition-visible" ? ["IME-commit"] : [],
        );
        if (test === "composition-reopen") {
          await page.evaluate(() => {
            globalThis.terminalFixture.compositionStart("fresh");
            globalThis.terminalFixture.compositionEnd("fresh");
            globalThis.terminalFixture.textInput(
              "fresh",
              "insertFromComposition",
            );
          });
          assert.deepEqual(
            await page.evaluate(() => globalThis.terminalFixture.input),
            ["fresh"],
          );
        }
      } else if (test.startsWith("input-")) {
        await page.evaluate(() => {
          globalThis.terminalFixture.hide();
          globalThis.terminalFixture.textInput("background-input");
        });
        assert.deepEqual(
          await page.evaluate(() => globalThis.terminalFixture.input),
          [],
        );
        if (test === "input-reopen") {
          await page.evaluate(() => {
            globalThis.terminalFixture.show();
            globalThis.terminalFixture.textInput("foreground-input");
          });
          assert.deepEqual(
            await page.evaluate(() => globalThis.terminalFixture.input),
            ["foreground-input"],
          );
        }
      } else if (test === "hidden-reports") {
        await page.evaluate(() => {
          globalThis.terminalFixture.reporting();
          globalThis.terminalFixture.hide();
          const canvas = document.querySelector("#visible canvas");
          canvas.dispatchEvent(
            new PointerEvent("pointermove", {
              clientX: 12,
              clientY: 10,
              bubbles: true,
            }),
          );
          canvas.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: 120,
              bubbles: true,
              cancelable: true,
            }),
          );
          document.querySelector("#visible textarea").dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "a",
              code: "KeyA",
              bubbles: true,
            }),
          );
        });
        assert.deepEqual(
          await page.evaluate(() => globalThis.terminalFixture.input),
          [],
        );
      } else if (test === "hidden") {
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
      } else if (test === "tabs") {
        const geometry = await page.evaluate(() =>
          globalThis.terminalFixture.tabs()
        );
        assert.deepEqual(geometry.styles, {
          header: "flex",
          strip: "flex",
          wrap: "wrap",
          shrink: "1",
        });
        assert(
          geometry.strip.right <= geometry.header.right + .5,
          "noncompact tab strip must fit its header",
        );
        assert(
          Math.max(...geometry.rows) > Math.min(...geometry.rows),
          "noncompact tabs must wrap",
        );
      } else if (test.startsWith("paste-")) {
        if (test === "paste-mac") {
          await page.evaluate(() =>
            Object.defineProperty(navigator, "platform", {
              configurable: true,
              value: "MacIntel",
            })
          );
        }
        await page.evaluate(() => globalThis.terminalFixture.startPaste());
        if (test === "paste-hidden" || test === "paste-hidden-reopen") {
          await page.evaluate(() => globalThis.terminalFixture.hide());
          if (test === "paste-hidden-reopen") {
            await page.evaluate(() => globalThis.terminalFixture.show());
          }
          await page.evaluate(() =>
            globalThis.terminalFixture.completePaste("background-input")
          );
          assert.deepEqual(
            await page.evaluate(() => globalThis.terminalFixture.input),
            [],
          );
        } else if (test === "paste-native-first") {
          await page.evaluate(() =>
            globalThis.terminalFixture.nativePaste("once")
          );
          await page.evaluate(() =>
            globalThis.terminalFixture.completePaste("once")
          );
          assert.deepEqual(
            await page.evaluate(() => globalThis.terminalFixture.input),
            ["once"],
          );
        } else {
          await page.evaluate(() =>
            globalThis.terminalFixture.completePaste("once")
          );
          await page.evaluate(() =>
            globalThis.terminalFixture.nativePaste("once")
          );
          assert.deepEqual(
            await page.evaluate(() => globalThis.terminalFixture.input),
            ["once"],
          );
        }
      } else if (test === "rtl") {
        const canvas = page.locator("#visible canvas");
        await page.evaluate(() => globalThis.terminalFixture.direction("ltr"));
        const ltr = await canvas.evaluate((element) => element.toDataURL());
        await page.evaluate(() => globalThis.terminalFixture.direction("rtl"));
        assert.equal(
          await canvas.evaluate((element) => element.toDataURL()) === ltr,
          true,
          "terminal text uses physical left alignment independently of surrounding direction",
        );
      } else if (test === "scrollbar" || test === "scrollbar-accessibility") {
        await page.evaluate(() => globalThis.terminalFixture.scrollback());
        const bar = page.locator("#visible [role=scrollbar]");
        if (test === "scrollbar-accessibility") {
          const relations = await page.locator("[role=scrollbar]").evaluateAll((
            nodes,
          ) =>
            nodes.map((bar) => {
              const id = bar.getAttribute("aria-controls"),
                target = id && document.getElementById(id);
              return {
                id,
                accessible: !!target &&
                  target.getAttribute("aria-hidden") !== "true",
                role: target && target.getAttribute("role"),
                sameMount:
                  target === bar.parentElement?.querySelector("canvas"),
              };
            })
          );
          assert.equal(relations.length, 2);
          assert(
            relations.every((item) =>
              item.id && item.accessible && item.role === "img" &&
              item.sameMount
            ),
          );
          assert.equal(
            new Set(relations.map((item) => item.id)).size,
            relations.length,
          );
        } else {
          const box = await bar.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 5);
          await page.mouse.down();
          await page.evaluate(() => globalThis.terminalFixture.armScrollMove());
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
          await page.mouse.up();
          await page.waitForFunction(
            () => {
              const bar = document.querySelector("#visible [role=scrollbar]");
              const now = Number(bar.getAttribute("aria-valuenow")),
                max = Number(bar.getAttribute("aria-valuemax"));
              return now > 0 && now < max / 2;
            },
            undefined,
            { timeout: 1500 },
          );
        }
      } else if (test === "selection-blink") {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.clock.install();
        await page.evaluate(() =>
          globalThis.terminalFixture.prepareSelection()
        );
        await page.clock.runFor(64);
        const before = await page.evaluate(() => ({
          ...globalThis.terminalFixture.selections[0],
        }));
        assert(before.text.includes("selected-output"));
        await page.clock.runFor(1100);
        assert.deepEqual(
          await page.evaluate(() => globalThis.terminalFixture.selections[0]),
          before,
          "idle cursor paints must not reformat the selection",
        );
        for (
          const action of [
            "selectionOutput",
            "selectionReplay",
            "selectionResize",
          ]
        ) {
          const prior = await page.evaluate(() =>
            globalThis.terminalFixture.selections[0].notifications
          );
          await page.evaluate(
            (action) => globalThis.terminalFixture[action](),
            action,
          );
          await page.clock.runFor(64);
          assert(
            await page.evaluate(() =>
              globalThis.terminalFixture.selections[0].notifications
            ) > prior,
            action + " must notify the selection consumer",
          );
        }
      } else if (test === "hover") {
        await page.clock.install();
        await page.clock.pauseAt(new Date());
        await page.evaluate(() => globalThis.terminalFixture.prepareLink());
        await page.clock.runFor(32);
        const box = await page.locator("#visible canvas").boundingBox();
        await page.mouse.move(box.x + 12, box.y + 10);
        await page.clock.runFor(160);
        await page.evaluate(() => globalThis.terminalFixture.changeLinkRow());
        await page.clock.runFor(200);
        assert.equal(
          await page.evaluate(() =>
            globalThis.terminalFixture.hover.filter((item) =>
              item.text !== null
            ).length
          ),
          0,
          "row changes revoke the pending hover deadline",
        );
        await page.clock.runFor(100);
        assert(
          await page.evaluate(() =>
            globalThis.terminalFixture.hover.some((item) =>
              item.text === "https://a.test/"
            )
          ),
        );
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
