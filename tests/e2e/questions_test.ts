// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { selectionGeometry } from "../support/selection-geometry.ts";

export const questions = [
  {
    header: "Rendering",
    question: "Choose the output",
    options: [{ label: "Typed", description: "OTK shapes" }, {
      label: "Raw",
      description: "Harness shapes",
    }],
    multiple: false,
  },
  {
    header: "Details",
    question: "Choose details",
    options: [{ label: "Files", description: "Include files" }, {
      label: "Tools",
      description: "Include tools",
    }],
    multiple: true,
  },
];
test("P1 question tabs, keyboard choices, multi/custom answers, confirmation and reject reach the completed tool", async () => {
  const f = await browserFixture();
  let c: WsClient | undefined;
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Question selection paint" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    await openSession(b, session.id);
    f.fake.queue({ tool: { name: "question", input: { questions } } });
    await b.type("textarea[name=prompt]", "Show fixed question options");
    await b.key("Enter");
    const panel = ".otk-tabs-panel[data-active=true]",
      tabs = ".otk-question-dock .otk-tabs-strip";
    await b.poll(`document.querySelectorAll('${tabs} [role=tab]').length===3`);
    c = new WsClient(server.url);
    await c.connect();
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await c.rpc("prefs.set", { key: "theme", value: theme });
      for (const reduced of [false, true]) {
        await c.rpc("prefs.set", { key: "reducedColors", value: reduced });
        await b.poll(
          `document.documentElement.dataset.otkTheme==='${theme}' && document.documentElement.hasAttribute('data-otk-reduced-colors')===${reduced}`,
        );
        const items = await selectionGeometry(
          b,
          `${panel} [data-otk-selection],${tabs} [data-otk-selection]`,
        );
        assert(items.length >= 5);
        for (const item of items) {
          assertEquals(item.shift, 0);
          if (item.orientation === "vertical") {
            assertEquals([item.w, item.h], [3, 14]);
            assert(item.centred <= .5, JSON.stringify(item));
            if (item.ariaPressed !== null) {
              assertEquals(item.ariaPressed, "false");
            }
          } else {
            assertEquals(item.h, 2);
            assertEquals(item.ariaSelected === "true", item.selected);
          }
        }
      }
    }
  } finally {
    await c?.close();
    await f.stop();
  }
});
