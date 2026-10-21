// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { selectionGeometry } from "../support/selection-geometry.ts";
import { waitFor } from "../support/opencode.ts";
const panel = ".otk-tabs-panel[data-active=true]";
const tabs = ".otk-question-dock .otk-tabs-strip";
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
Deno.test("P1 question tabs, keyboard choices, multi/custom answers, confirmation and reject reach the completed tool", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Questions" },
      }),
      server = await f.sidecar(),
      browser = await f.browser(server.url);
    await openSession(browser, session.id);
    f.fake.queue({ tool: { name: "question", input: { questions } } }, {
      chunks: ["Answers recorded."],
    });
    await browser.type(
      "textarea[name=prompt]",
      "Ask the interaction questions",
    );
    await browser.key("Enter");
    await browser.poll(
      `document.querySelectorAll('${tabs} [role=tab]').length===3`,
    );
    const [pointer] = await selectionGeometry(
      browser,
      `${panel} [data-question-row]:first-child`,
    );
    const [tab] = await selectionGeometry(
      browser,
      `${tabs} [aria-selected=true]`,
    );
    assertEquals([pointer.w, pointer.h, tab.h], [3, 14, 2]);
    assert(pointer.centred < .5);
    const client = new WsClient(server.url);
    await client.connect();
    try {
      for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
        await client.rpc("prefs.set", { key: "theme", value: theme });
        for (const reduced of [false, true]) {
          await client.rpc("prefs.set", {
            key: "reducedColors",
            value: reduced,
          });
          await browser.poll(
            `document.documentElement.dataset.otkTheme==='${theme}' && document.documentElement.hasAttribute('data-otk-reduced-colors')===${reduced}`,
          );
          assertEquals(
            await browser.evaluate(
              `(()=>{const e=document.querySelector('${panel} [data-question-row]'),p=getComputedStyle(e,'::before'),t=document.querySelector('${tabs} [aria-selected=true]');return [p.width,p.height,getComputedStyle(t,'::after').height]})()`,
            ),
            ["3px", "14px", "2px"],
          );
          const items = await selectionGeometry(
            browser,
            `${panel} [data-otk-selection],${tabs} [data-otk-selection]`,
          );
          assert(items.length >= 5);
          for (const item of items) {
            assertEquals(item.shift, 0);
            if (item.orientation === "vertical") {
              assertEquals([item.w, item.h], [3, 14]);
              assert(item.centred <= .5, JSON.stringify(item));
              if (item.ariaPressed !== null) {
                assertEquals(
                  item.ariaPressed,
                  "false",
                  "No answer is committed before a pick",
                );
              }
            } else {
              assertEquals(item.h, 2);
              assertEquals(item.ariaSelected === "true", item.selected);
            }
          }
        }
      }
      await client.rpc("prefs.set", { key: "reducedColors", value: false });
      await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
    } finally {
      await client.close();
    }
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-question-options button').textContent.includes('1.')",
      ),
      false,
    );
    assert(
      await browser.evaluate(
        "document.querySelector('.otk-question-actions button:nth-child(2)').title.includes('Esc') && !document.querySelector('.otk-question-actions').textContent.includes('j/k')",
      ),
    );
    await browser.screenshot(join(f.oc.root, "p1-question-tabs.png"));
    assertEquals(
      await browser.evaluate("document.activeElement?.getAttribute('name')"),
      null,
      "Question arrival must not put focus into an answer action",
    );
    await browser.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "1",
      code: "Digit1",
      windowsVirtualKeyCode: 49,
      nativeVirtualKeyCode: 49,
      text: "1",
    });
    await browser.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "1",
      code: "Digit1",
      windowsVirtualKeyCode: 49,
      nativeVirtualKeyCode: 49,
    });
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='' && document.querySelector('.otk-question-dock p').textContent.includes('Choose the output') && !!document.querySelector('.otk-prompt').closest('[hidden]')",
    );
    await browser.click(`${tabs} [role=tab]:first-child`);
    await browser.key("1");
    await browser.poll(
      `document.querySelector('${panel} button').getAttribute('aria-pressed')==='true'`,
    );
    // Picking is an intent; Answer explicitly advances to the next step.
    await browser.click(".otk-question-actions .otk-primary");
    await browser.poll(
      `document.querySelector('${panel} p').textContent==='Choose details (select all that apply)'`,
    );
    await browser.click(`${tabs} [role=tab]:nth-child(2)`);
    await browser.key("2");
    await browser.poll(
      `document.querySelector('${panel} button:nth-child(2)').getAttribute('aria-pressed')==='true'`,
    );
    await browser.click(`${panel} [data-question-row]:last-child`);
    await browser.fill(
      `${panel} textarea[name=question-answer]`,
      "Custom detail",
    );
    await browser.key("Enter");
    await browser.poll(
      `document.activeElement===document.querySelector('.otk-question-actions .otk-primary') && document.querySelector('${panel} button:nth-child(2)').getAttribute('aria-pressed')==='true'`,
    );
    await browser.key("ArrowRight");
    await browser.poll(
      `document.querySelector('${panel} dd')?.textContent==='Typed' && document.querySelector('${panel} dl').textContent.includes('Tools, Custom detail')`,
    );
    await browser.screenshot(join(f.oc.root, "p1-question-confirm.png"));
    const geometry = await browser.evaluate<
      {
        buttonGap: number;
        actionsRight: number;
        buttonRight: number;
        dockRight: number;
      }
    >("(()=>{const d=document.querySelector('.otk-question-dock'),buttons=[...d.querySelectorAll('.otk-question-actions button')],a=buttons[0].getBoundingClientRect(),b=buttons[1].getBoundingClientRect();return {buttonGap:b.left-a.right,actionsRight:d.querySelector('.otk-question-actions').getBoundingClientRect().right,buttonRight:b.right,dockRight:d.getBoundingClientRect().right}})()");
    assert(
      geometry.buttonGap >= 4,
      "Question actions must have structural spacing",
    );
    assert(
      geometry.buttonRight <= geometry.actionsRight,
      "Question actions stay within their structural row",
    );
    assert(
      geometry.actionsRight <= geometry.dockRight - .5,
      "Question actions stay within the dock; keyboard help is in titles",
    );
    await browser.click(`${tabs} [role=tab]:first-child`);
    await browser.key("l");
    await browser.key("h");
    await browser.key("l");
    await browser.key("l");
    await browser.poll(
      `document.querySelector('${tabs} button:last-child').getAttribute('aria-selected')==='true'`,
    );
    await browser.click(".otk-question-actions .otk-primary");
    await browser.poll(
      "!document.querySelector('.otk-question-dock') && document.querySelector('.otk-questions').textContent.includes('Typed') && document.querySelector('.otk-questions').textContent.includes('Tools, Custom detail')",
    );
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status==='idle'`,
    );
    const history = await waitFor(
      () =>
        f.oc.request<
          {
            parts: {
              tool?: string;
              state?: { metadata?: { answers?: string[][] } };
            }[];
          }[]
        >(`/session/${session.id}/message`),
      (rows) =>
        rows.some((row) =>
          row.parts.some((part) =>
            part.tool === "question" && !!part.state?.metadata?.answers
          )
        ),
    );
    assertEquals(
      history.flatMap((row) => row.parts).find((part) =>
        part.tool === "question"
      )?.state?.metadata?.answers,
      [["Typed"], ["Tools", "Custom detail"]],
      "Confirm sends the exact picks and own answer to opencode",
    );
    await browser.poll(
      "document.querySelector('.otk-message-flow').textContent.includes('Answers recorded.')",
    );
    f.fake.queue({
      tool: { name: "question", input: { questions: [questions[0]] } },
    }, { chunks: ["Rejection recorded."] });
    await browser.type("textarea[name=prompt]", "Ask again, to reject");
    await browser.key("Enter");
    await browser.poll("!!document.querySelector('.otk-question-dock')");
    assertEquals(
      await browser.evaluate(
        `document.querySelectorAll('${tabs} [role=tab]').length`,
      ),
      2,
      "Single questions retain their Confirm step",
    );
    await browser.click(`${tabs} [role=tab]:first-child`);
    await browser.key("Escape");
    await browser.poll(
      "!document.querySelector('.otk-question-dock') && document.querySelector('[data-tool-status=denied] .otk-questions dd')?.textContent==='Dismissed'",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('.otk-prompt-actions').textContent.includes('esc again')",
      ),
      false,
    );
  } finally {
    await f.stop();
  }
});
