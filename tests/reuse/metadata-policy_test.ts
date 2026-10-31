// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { test } from "../support/resources.ts";
import { uiConsumer } from "../support/ui-consumer.ts";

test("an independent public UI consumer borrows server path flavor, feature formatters and output policy", async () => {
  const f = await uiConsumer("?metadata-policy");
  const b = f.browser;
  try {
    await b.poll(
      "document.querySelector('[data-path]')?.textContent==='src\\\\file.ts'",
    );
    assertEquals(
      await b.evaluate("document.querySelector('[data-format]').textContent"),
      "1,234,567 1.2s 1d 1h",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('pre').textContent.split('\\n').length",
      ),
      10,
    );
    await b.click(".otk-output-toggle");
    assertEquals(
      await b.evaluate(
        "document.querySelector('pre').textContent.split('\\n').length",
      ),
      15,
    );
    await b.evaluate(
      "document.documentElement.style.setProperty('--font-ui', '\"Quoted\" & <unsafe>')",
    );
    await b.poll(
      "decodeURIComponent(document.querySelector('link[rel=icon]').href).includes('&amp;')",
    );
    const svg = await b.evaluate<
      { font: string; expected: string; unsafe: number }
    >(`(()=>{
      const source=decodeURIComponent(document.querySelector('link[rel=icon]').href.split(',').slice(1).join(','));
      const svg=new DOMParser().parseFromString(source,'image/svg+xml');
      return {font:svg.querySelector('text').getAttribute('font-family'),expected:getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim(),unsafe:svg.querySelectorAll('unsafe,script,parsererror').length};
    })()`);
    assertEquals(svg.font, svg.expected);
    assertEquals(svg.unsafe, 0);
    assertEquals(b.errors, []);
  } finally {
    await f.close();
  }
});
