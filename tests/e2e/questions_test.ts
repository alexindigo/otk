// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
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
      "document.querySelectorAll('.otk-question-tabs [role=tab]').length===3",
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
    await browser.click(".otk-question-tabs [role=tab]:first-child");
    await browser.key("1");
    await browser.poll(
      "document.querySelector('.otk-question-dock p').textContent.includes('Choose details')",
    );
    await browser.key("2");
    await browser.poll(
      "document.querySelector('.otk-question-options button:nth-child(2)').getAttribute('aria-pressed')==='true'",
    );
    await browser.click(".otk-question-options button:last-child");
    await browser.fill("textarea[name=question-answer]", "Custom detail");
    await browser.key("Enter");
    await browser.key("Tab");
    await browser.poll(
      "document.activeElement===document.querySelector('.otk-question-tabs button:first-child') && document.querySelector('.otk-question-options button:nth-child(2)').getAttribute('aria-pressed')==='true'",
    );
    await browser.key("ArrowRight");
    await browser.poll(
      "document.querySelector('.otk-question-dock dd')?.textContent==='Typed' && document.querySelector('.otk-question-dock dl').textContent.includes('Custom detail')",
    );
    await browser.screenshot(join(f.oc.root, "p1-question-confirm.png"));
    const geometry = await browser.evaluate<
      {
        buttonGap: number;
        helpGap: number;
        helpTop: number;
        buttonBottom: number;
        helpRight: number;
        dockRight: number;
      }
    >("(()=>{const d=document.querySelector('.otk-question-dock'),buttons=[...d.querySelectorAll('button')].filter(el=>el.textContent.trim()==='Answer'||el.textContent.trim()==='Reject question'),a=buttons[0].getBoundingClientRect(),b=buttons[1].getBoundingClientRect(),h=d.querySelector('span.otk-muted').getBoundingClientRect();return {buttonGap:b.left-a.right,helpGap:h.left-b.right,helpTop:h.top,buttonBottom:b.bottom,helpRight:h.right,dockRight:d.getBoundingClientRect().right}})()");
    assert(
      geometry.buttonGap >= 4,
      "Question actions must have structural spacing",
    );
    assert(
      geometry.helpGap >= 4 || geometry.helpTop >= geometry.buttonBottom + 4,
      "Question key help must be separated from buttons, including wrapped rows",
    );
    assert(
      geometry.helpRight <= geometry.dockRight - .5,
      "Question key help must stay within the dock",
    );
    await browser.click(".otk-question-dock button[role=tab]:first-child");
    await browser.key("l");
    await browser.key("h");
    await browser.key("l");
    await browser.key("l");
    await browser.poll(
      "document.querySelector('.otk-question-tabs button:last-child').getAttribute('aria-selected')==='true'",
    );
    await browser.click(".otk-question-dock button:not([role=tab])");
    await browser.poll(
      "!document.querySelector('.otk-question-dock') && document.querySelector('.otk-questions').textContent.includes('Typed') && document.querySelector('.otk-questions').textContent.includes('Tools, Custom detail')",
    );
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status==='idle'`,
    );
    f.fake.queue({
      tool: { name: "question", input: { questions: [questions[0]] } },
    }, { chunks: ["Rejection recorded."] });
    await browser.type("textarea[name=prompt]", "Ask again, to reject");
    await browser.key("Enter");
    await browser.poll("!!document.querySelector('.otk-question-dock')");
    assertEquals(
      await browser.evaluate(
        "document.querySelectorAll('.otk-question-tabs [role=tab]').length",
      ),
      2,
      "Single questions retain their Confirm step",
    );
    await browser.click(".otk-question-tabs [role=tab]:first-child");
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
