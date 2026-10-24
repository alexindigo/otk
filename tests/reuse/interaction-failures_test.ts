// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { uiConsumer } from "../support/ui-consumer.ts";

test("unregistered typed tool and part fallbacks ignore colliding extension-only fields", async () => {
  const f = await uiConsumer("?interaction-failures"), b = f.browser;
  try {
    await b.poll("document.body.textContent.includes('Unsupported part:')");
    await b.click('.otk-tool-toggle[aria-expanded="false"]');
    await b.poll("!document.querySelector('.otk-tool-body').hidden");
    assertEquals(
      await b.evaluate("document.querySelector('.otk-muted')?.textContent"),
      "Unsupported part: consumer.unregistered",
    );
    assertEquals(
      await b.evaluate(
        "document.body.textContent.includes('Output truncated.')",
      ),
      false,
    );
    await b.poll(
      "document.body.textContent.includes('Common output survives an unregistered extension.')",
    );
    assertEquals(b.errors, []);
  } finally {
    await f.close();
  }
});

test("paste drop and clipboard refusals reach owned feedback without clearing input or losing reply", async () => {
  const f = await uiConsumer("?interaction-failures"), b = f.browser;
  try {
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.evaluate(
      "Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{writeText:()=>Promise.reject(new Error('Clipboard refused'))} })",
    );
    for (const theme of ["dark", "light"]) {
      await b.click(`[data-${theme}]`);
      await b.fill(".otk-prompt textarea", "Retain this unsent input");
      for (const mode of ["sync", "async"]) {
        for (const event of ["paste", "drop"]) {
          await b.click(`[data-${mode}]`);
          await b.evaluate(
            `document.querySelector('${
              event === "paste" ? ".otk-prompt textarea" : ".otk-prompt"
            }').dispatchEvent(new ${
              event === "paste"
                ? "ClipboardEvent('paste', {bubbles:true,cancelable:true})"
                : "DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer:new DataTransfer()})"
            })`,
          );
          await b.poll(
            `document.querySelector('.otk-prompt [role=alert]')?.textContent==='${
              mode === "sync" ? "Synchronous" : "Asynchronous"
            } ${event} refusal'`,
          );
          assertEquals(
            await b.evaluate(
              "document.querySelector('.otk-prompt textarea').value",
            ),
            "Retain this unsent input",
          );
        }
      }
      await b.click(".otk-copy-message");
      await b.poll(
        "document.querySelector('.otk-message [role=alert]')?.textContent==='Clipboard refused'",
      );
      await b.poll(
        "document.body.textContent.includes('Keep this reply available')",
      );
      assertEquals(b.errors, []);
      const shots = Deno.env.get("OTK_B5_INTERACTION_SHOTS");
      if (shots) {
        await b.evaluate(
          "document.activeElement?.blur();document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
        );
        await b.screenshot(join(shots, `quality-B5-interactions-${theme}.png`));
      }
    }
  } finally {
    await f.close();
  }
});

test("a clipboard refusal is visible at the reply action without an unhandled rejection", async () => {
  const f = await uiConsumer("?interaction-failures"), b = f.browser;
  try {
    await b.evaluate(
      "Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{writeText:()=>Promise.reject(new Error('Clipboard refused'))} })",
    );
    await b.click(".otk-copy-message");
    await b.poll(
      "document.querySelector('.otk-message [role=alert]')?.textContent==='Clipboard refused'",
    );
    assertEquals(b.errors, []);
  } finally {
    await f.close();
  }
});
