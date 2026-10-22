// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
import { McpFixture } from "../support/mcp.ts";
import { waitFor } from "../support/opencode.ts";
test("empty completion results leave Enter, native ArrowUp and normal Escape owned by the prompt", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Empty completions" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    const query = "otk_no_matching_file_927431";
    const ready = async () => {
      const request = await waitFor(
        () =>
          sentFrames(browser).findLast((item) =>
            item.frame.method === "find.files" &&
            (item.frame.params as { query?: string })?.query === query
          ),
        (item) => !!item,
      );
      await waitFor(
        () =>
          browser.events.some((event) =>
            event.method === "Network.webSocketFrameReceived" && (() => {
              const frame = JSON.parse(
                (event.params.response as { payloadData: string }).payloadData,
              );
              return frame.t === "rpc.result" && frame.id === request!.frame.id;
            })()
          ),
        (value) => value,
      );
      await browser.poll("!document.querySelector('.otk-autocomplete')");
    };
    const reply = f.fake.queueHeld({ chunks: ["No-match prompt submitted."] });
    await browser.type("textarea[name=prompt]", "@" + query);
    await ready();
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('[data-role=user] .otk-text')?.textContent.includes(${
        JSON.stringify("@" + query)
      }) && document.querySelector('textarea[name=prompt]').value===''`,
    );
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]')?.dataset.status==='busy'`,
    );
    await browser.type("textarea[name=prompt]", "@" + query);
    await ready();
    await browser.evaluate(
      "(()=>{const input=document.querySelector('textarea[name=prompt]');globalThis.emptyArrowPrevented=null;input.addEventListener('keydown',event=>{if(event.key==='ArrowUp')queueMicrotask(()=>{globalThis.emptyArrowPrevented=event.defaultPrevented})},{once:true})})()",
    );
    await browser.key("ArrowUp");
    await browser.poll("emptyArrowPrevented!==null");
    assertEquals(await browser.evaluate("emptyArrowPrevented"), false);
    await browser.fill("textarea[name=prompt]", "@" + query);
    await ready();
    await browser.key("Escape");
    await browser.poll(
      "document.querySelector('.otk-prompt button[type=submit]').title==='Esc again to interrupt'",
    );
    reply.release();
  } finally {
    await f.stop();
  }
});
test("P3/P4 file ranges, persisted frecency, directories, agent and MCP resource mentions reach stock harness", async () => {
  const mcp = new McpFixture(),
    f = await browserFixture(undefined, {
      config: {
        mcp: { fixture: { type: "remote", url: mcp.url, enabled: true } },
      },
      async prepare(oc) {
        await Deno.writeTextFile(
          join(oc.directory, "AAA.md"),
          "alphabetical first",
        );
        await Deno.writeTextFile(
          join(oc.directory, "README.md"),
          Array.from({ length: 30 }, (_, i) => `README line ${i + 1}`).join(
            "\n",
          ),
        );
        await Deno.mkdir(join(oc.directory, "docs"));
        await Deno.writeTextFile(join(oc.directory, "docs/guide.md"), "guide");
      },
    });
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Mentions" },
      }),
      other = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Frecency" },
      }),
      server = await f.sidecar(),
      browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await browser.type("textarea[name=prompt]", "@READ");
    await browser.poll(
      "document.querySelector('.otk-autocomplete')?.textContent.includes('README.md')",
    );
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('.otk-prompt-chip')?.textContent.includes('@README.md')",
    );
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('[data-role=user] .otk-chip')?.textContent.includes('README.md') && document.querySelector('textarea[name=prompt]').value===''",
    );
    await openSession(browser, other.id);
    await browser.type("textarea[name=prompt]", "@");
    await browser.poll(
      "document.querySelector('.otk-autocomplete button:first-child')?.textContent.includes('README.md')",
    );
    await browser.fill("textarea[name=prompt]", "@README.md#10-20");
    await browser.poll(
      "document.querySelector('.otk-autocomplete')?.textContent.includes('#10-20')",
    );
    await browser.key("Enter");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('[data-role=user] .otk-chip')?.textContent.includes('#10-20') && document.querySelector('textarea[name=prompt]').value===''",
    );
    await browser.type("textarea[name=prompt]", "@docs");
    await browser.poll(
      "document.querySelector('.otk-autocomplete')?.textContent.includes('docs/')",
    );
    await browser.key("Tab");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value==='@docs/' && document.querySelector('.otk-autocomplete')?.textContent.includes('guide.md')",
    );
    await browser.key("Escape");
    await browser.fill("textarea[name=prompt]", "@explore");
    await browser.poll(
      "document.querySelector('.otk-autocomplete')?.textContent.includes('explore')",
    );
    await browser.key("Enter");
    await browser.key("Enter");
    await browser.poll(
      "[...document.querySelectorAll('[data-role=user] .otk-chip')].some(el=>el.textContent.includes('Agent: explore'))",
    );
    await browser.fill("textarea[name=prompt]", "@specification");
    await browser.poll(
      "document.querySelector('.otk-autocomplete')?.textContent.includes('specification')",
    );
    await browser.screenshot(join(f.oc.root, "p3-mentions.png"));
    await browser.key("Enter");
    await browser.key("Enter");
    await browser.poll(
      "[...document.querySelectorAll('[data-role=user] .otk-text')].some(el=>el.textContent.includes('@specification')) && document.querySelector('textarea[name=prompt]').value===''",
    );
    await waitFor(
      () => f.fake.requests,
      (requests) =>
        requests.some((body) =>
          JSON.stringify(body.messages).includes(
            "MCP fixture specification bytes",
          )
        ),
    );
    assertEquals(
      mcp.requests.some((request) => request.method === "resources/read"),
      true,
    );
    await browser.reload();
    await browser.poll("!!document.querySelector('.otk-prompt')");
    await browser.fill("textarea[name=prompt]", "@");
    await browser.poll(
      "document.querySelector('.otk-autocomplete button:first-child')?.textContent.includes('README.md')",
    );
  } finally {
    await f.stop();
    await mcp.stop();
  }
});
