// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
const palette = "dialog[aria-label=Commands][open]";
const keys = "dialog[aria-label='Keyboard shortcuts'][open]";
test("D1 palette, project button and slash create sessions through the same registered command", async () => {
  const f = await browserFixture();
  try {
    const seed = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Command invokers" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, seed.id);
    await browser.click(".otk-sidebar-commands button:first-child");
    await browser.poll(`!!document.querySelector('${palette}')`);
    await browser.fill("input[name=command-search]", "New session");
    await browser.click("[data-command='session.new']");
    await browser.poll(
      `!location.hash.endsWith('/${seed.id}') && !document.querySelector('${palette}') && !!document.querySelector('.otk-prompt')`,
    );
    const first = await browser.evaluate<string>("location.hash");
    await browser.poll(
      "!!document.querySelector('.otk-project-tabs .otk-new-session:not(:disabled)')",
    );
    await browser.click(".otk-project-tabs .otk-new-session");
    await browser.poll(
      `location.hash!==${
        JSON.stringify(first)
      } && !!document.querySelector('.otk-prompt')`,
    );
    const second = await browser.evaluate<string>("location.hash");
    await browser.fill("textarea[name=prompt]", "/new");
    await browser.poll(
      "document.querySelector('.otk-autocomplete')?.textContent.includes('/new')",
    );
    await browser.key("Enter");
    await browser.poll(
      `location.hash!==${
        JSON.stringify(second)
      } && document.querySelector('textarea[name=prompt]')?.value===''`,
    );
    assertEquals((await f.oc.request<unknown[]>("/session")).length, 4);
    assertEquals(
      sentFrames(browser).filter(({ frame }) =>
        frame.method === "session.create"
      ).length,
      3,
    );
  } finally {
    await f.stop();
  }
});
test("D3 Esc closes palette before permission confirmation and real double Esc interrupts", async () => {
  const f = await browserFixture();
  try {
    const seed = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Escape layers" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, seed.id);
    f.fake.queue({
      tool: {
        name: "bash",
        input: { command: "echo layers", description: "layer proof" },
      },
    }, { chunks: ["After permission."] });
    await browser.type("textarea[name=prompt]", "Run the layer probe");
    await browser.key("Enter");
    await browser.poll("!!document.querySelector('.otk-permission-dock')");
    await browser.click(".otk-permission-actions button:nth-child(2)");
    await browser.poll("!!document.querySelector('.otk-permission-confirm')");
    await browser.key("k", 2);
    await browser.poll(`!!document.querySelector('${palette}')`);
    await browser.key("Escape");
    await browser.poll(
      `!document.querySelector('${palette}') && !!document.querySelector('.otk-permission-confirm')`,
    );
    await browser.key("Escape");
    await browser.poll(
      "!document.querySelector('.otk-permission-confirm') && !!document.querySelector('.otk-permission-dock')",
    );
    assertEquals(
      sentFrames(browser).filter(({ frame }) =>
        frame.method === "session.abort"
      ).length,
      0,
    );
    await browser.click(".otk-permission-actions button:first-child");
    await browser.poll(
      `document.querySelector('[data-session="${seed.id}"]').dataset.status==='idle'`,
    );
    f.fake.queueHeld({ chunks: ["stream "] });
    await browser.fill("textarea[name=prompt]", "Interrupt this long turn");
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('[data-session="${seed.id}"]').dataset.status==='busy' && [...document.querySelectorAll('[data-role=assistant] .otk-text')].some(el=>el.textContent.includes('stream '))`,
    );
    await browser.key("Escape");
    await browser.poll(
      "document.querySelector('.otk-prompt button[type=submit]')?.title==='Esc again to interrupt'",
    );
    await browser.key("Escape");
    await browser.poll(
      `document.querySelector('[data-session="${seed.id}"]').dataset.status==='idle' && [...document.querySelectorAll('.otk-message-footer')].some(el=>el.textContent.includes('interrupted'))`,
    );
    assertEquals(
      sentFrames(browser).filter(({ frame }) =>
        frame.method === "session.abort"
      ).length,
      1,
    );
  } finally {
    await f.stop();
  }
});
test("D4 production rebind UI rejects conflicts, applies the new key, persists on reload and resets", async () => {
  const f = await browserFixture();
  try {
    const seed = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Rebind proof" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, seed.id);
    await browser.click(".otk-keys-entry");
    await browser.poll(`!!document.querySelector("${keys}")`);
    await browser.poll(
      "document.querySelector('[data-binding=\"prompt.newline\"] > span')?.textContent.includes('Insert newline') && document.querySelector('[data-binding=\"prompt.submit\"] > span')?.textContent.includes('Send prompt')",
    );
    await browser.click("[data-binding='palette.open'] button:first-of-type");
    await browser.click("[data-binding='palette.open'] input");
    await browser.key("?", 8);
    await browser.poll(
      "document.querySelector('.otk-dialog [role=alert]')?.textContent.includes('Conflicts with help.keys')",
    );
    assertEquals(
      sentFrames(browser).filter(({ frame }) => frame.method === "prefs.set")
        .length,
      0,
    );
    await browser.key("j", 2);
    await browser.poll(
      "document.querySelector('[data-binding=\"palette.open\"] kbd')?.textContent==='Ctrl+j' && !document.querySelector('[data-binding=\"palette.open\"] input')",
    );
    await browser.key("Escape");
    await browser.click("textarea[name=prompt]");
    await browser.key("j", 2);
    await browser.poll(`!!document.querySelector('${palette}')`);
    await browser.key("Escape");
    await browser.reload();
    await browser.poll("!!document.querySelector('.otk-prompt')");
    await browser.click(".otk-keys-entry");
    await browser.poll(`!!document.querySelector("${keys}")`);
    await browser.poll(
      "document.querySelector('[data-binding=\"palette.open\"] kbd')?.textContent==='Ctrl+j'",
    );
    await browser.key("Escape");
    await browser.click("textarea[name=prompt]");
    await browser.key("j", 2);
    await browser.poll(`!!document.querySelector('${palette}')`);
    await browser.key("Escape");
    await browser.click(".otk-keys-entry");
    await browser.poll(`!!document.querySelector("${keys}")`);
    await browser.click("[data-binding='palette.open'] button:last-of-type");
    await browser.poll(
      "document.querySelector('[data-binding=\"palette.open\"] kbd')?.textContent==='Mod+k'",
    );
    await browser.key("Escape");
    await browser.click("textarea[name=prompt]");
    await browser.key("k", 2);
    await browser.poll(`!!document.querySelector('${palette}')`);
  } finally {
    await f.stop();
  }
});
test("essential Tab cycling selects primary agents in prompt, reverse cycles and sent messages carry selection", async () => {
  const f = await browserFixture();
  try {
    const seed = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Agent keys" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, seed.id);
    await browser.click("textarea[name=prompt]");
    await browser.key("Tab");
    await browser.poll(
      "document.querySelector('.otk-composer-agent')?.textContent==='Plan'",
    );
    await browser.key("Tab", 8);
    await browser.poll(
      "document.querySelector('.otk-composer-agent')?.textContent==='Build'",
    );
    await browser.key("Tab");
    await browser.poll(
      "document.querySelector('.otk-composer-agent')?.textContent==='Plan'",
    );
    await browser.type("textarea[name=prompt]", "Use the selected agent");
    await browser.key("Enter", 8);
    await browser.poll(
      "document.querySelector('textarea[name=prompt]').value.endsWith('\\n')",
    );
    assertEquals(f.fake.requests.length, 0);
    await browser.key("Enter");
    await browser.poll("!!document.querySelector('[data-role=user]')");
    const sent = sentFrames(browser).find(({ frame }) =>
      frame.method === "session.prompt"
    )!.frame.params as { agent: string };
    assertEquals(sent.agent, "plan");
    const messages = await f.oc.request<
      { info: { role: string; agent?: string } }[]
    >(`/session/${seed.id}/message`);
    assert(
      messages.some((row) =>
        row.info.role === "user" && row.info.agent === "plan"
      ),
    );
    await browser.click("textarea[name=prompt]");
    await browser.key("?", 8);
    await browser.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    assertEquals(
      await browser.evaluate(
        "!!document.querySelector(\"dialog[aria-label='Keyboard shortcuts'][open]\")",
      ),
      false,
    );
  } finally {
    await f.stop();
  }
});
test("agent cycling honors the native configured-default primary order without changing an unselected prompt", async () => {
  const f = await browserFixture(undefined, {
    config: { default_agent: "plan" },
  });
  try {
    const seed = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Configured default cycle" },
    });
    const native = await f.oc.request<
      { name: string; mode: string; hidden?: boolean }[]
    >("/agent");
    const primary = native.filter((agent) =>
      !agent.hidden && agent.mode !== "subagent"
    );
    assertEquals(primary.map((agent) => agent.name), ["plan", "build"]);
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, seed.id);
    await browser.type("textarea[name=prompt]", "Keep the backend default");
    await browser.key("Enter");
    await browser.poll("!!document.querySelector('[data-role=user]')");
    const unselected = sentFrames(browser).find(({ frame }) =>
      frame.method === "session.prompt"
    )!.frame.params;
    assertEquals((unselected as { agent: string }).agent, "plan");
    await browser.poll(
      `document.querySelector('[data-session="${seed.id}"]').dataset.status==='idle'`,
    );
    await browser.click("textarea[name=prompt]");
    await browser.key("Tab");
    await browser.poll(
      "document.querySelector('.otk-composer-agent')?.textContent==='Build'",
    );
    await browser.key("Tab", 8);
    await browser.poll(
      "document.querySelector('.otk-composer-agent')?.textContent==='Plan'",
    );
    await browser.key("Tab", 8);
    await browser.poll(
      "document.querySelector('.otk-composer-agent')?.textContent==='Build'",
    );
    await browser.type("textarea[name=prompt]", "Send the cycled agent");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelectorAll('[data-role=user]').length===2",
    );
    const messages = await f.oc.request<
      { info: { role: string; agent?: string } }[]
    >(`/session/${seed.id}/message`);
    assertEquals(
      messages.filter((row) =>
        row.info.role === "user"
      ).map((row) => row.info.agent),
      ["plan", "build"],
    );
  } finally {
    await f.stop();
  }
});
