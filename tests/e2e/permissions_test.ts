// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
} from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import type { Cdp } from "../support/cdp.ts";
async function clickText(browser: Cdp, label: string) {
  // Button layouts have separate wrappers; locate the actual button's geometry.
  const point = await browser.evaluate<{ x: number; y: number }>(
    `(()=>{const button=[...document.querySelectorAll('.otk-permission-dock button')].find(el=>el.textContent===${
      JSON.stringify(label)
    });button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await browser.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
    buttons: 1,
  });
  await browser.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
    buttons: 0,
  });
}
async function capture(browser: Cdp, root: string, name: string) {
  const path = join(root, name + ".png");
  await browser.screenshot(path);
  console.info("Permission capture:", path);
}
const bash = (command = "echo otk") => ({
  tool: { name: "bash", input: { command, description: "permission probe" } },
});
Deno.test("web typed edit and generic permission details render before rejected tools leave files unchanged", async () => {
  const f = await browserFixture({ bash: "ask", edit: "ask", read: "ask" });
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Typed permission details" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    const file = join(f.oc.directory, "README.md");
    f.fake.queue({ tool: { name: "read", input: { filePath: file } } }, {
      tool: {
        name: "edit",
        input: {
          filePath: file,
          oldString: "# OTK fixture",
          newString: "# Changed fixture",
        },
      },
    });
    await browser.type("textarea[name=prompt]", "Describe the proposed edit");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('.otk-permission-dock h2')?.textContent.includes('read') && document.querySelector('.otk-permission-dock')?.textContent.includes('README.md')",
      60_000,
    );
    await capture(browser, f.oc.root, "permission-generic-before-edit");
    await clickText(browser, "Allow once");
    await browser.poll(
      "document.querySelector('.otk-permission-dock')?.textContent.includes('README.md') && document.querySelector('.otk-permission-dock')?.textContent.includes('+1 / −1')",
      60_000,
    );
    await capture(browser, f.oc.root, "permission-edit-files");
    await clickText(browser, "Reject");
    await browser.poll("!!document.querySelector('textarea[name=rejection]')");
    await clickText(browser, "Reject request");
    await browser.poll(
      `!document.querySelector('.otk-permission-dock') && document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle'`,
      60_000,
    );
    assertEquals(await Deno.readTextFile(file), "# OTK fixture\n");
    f.fake.queue({ tool: { name: "read", input: { filePath: file } } });
    await browser.type("textarea[name=prompt]", "Describe the read permission");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('.otk-permission-dock h2')?.textContent.includes('read') && document.querySelector('.otk-permission-dock')?.textContent.includes('README.md')",
      60_000,
    );
    await capture(browser, f.oc.root, "permission-generic-summary");
    await clickText(browser, "Reject");
    await browser.poll("!!document.querySelector('textarea[name=rejection]')");
    await clickText(browser, "Reject request");
    await browser.poll(
      "!document.querySelector('.otk-permission-dock')",
      60_000,
    );
  } finally {
    await f.stop();
  }
});
Deno.test("E3 bash permission, real Allow once click, completed output-bearing tool and idle", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Permission once" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    await capture(browser, f.oc.root, "e3-before");
    f.fake.queue(bash(), { chunks: ["Permission completed"] });
    await browser.type("textarea[name=prompt]", "Run the permission probe");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('.otk-permission-command')?.textContent === 'echo otk'",
    );
    const geometry = await browser.evaluate<{ dock: number; prompt: number }>(
      "({dock:document.querySelector('.otk-permission-dock').getBoundingClientRect().bottom,prompt:document.querySelector('.otk-prompt').getBoundingClientRect().top})",
    );
    assert(Math.abs(geometry.dock - geometry.prompt) < .5);
    await capture(browser, f.oc.root, "e3-pending");
    await clickText(browser, "Allow once");
    await browser.poll(
      `!document.querySelector('.otk-permission-dock') && document.querySelector('[data-tool=bash][data-tool-status=completed]')?.textContent.includes('otk') && document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle'`,
      60_000,
    );
    const history = await f.oc.request<
      { parts: { type: string; state?: { output?: string } }[] }[]
    >(`/session/${session.id}/message`);
    assert(
      history.some((m) =>
        m.parts.some((p) =>
          p.type === "tool" && p.state?.output?.includes("otk")
        )
      ),
    );
    await capture(browser, f.oc.root, "e3-completed");
  } finally {
    await f.stop();
  }
});
Deno.test("E4 real subagent permission appears on parent dock with child title", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Parent delegation" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, session.id);
    f.fake.queue(
      {
        tool: {
          name: "task",
          input: {
            subagent_type: "general",
            description: "OTK child permission probe",
            prompt: "Run the scripted bash probe",
          },
        },
      },
      bash(),
      { chunks: ["Child completed"] },
      { chunks: ["Parent completed"] },
    );
    await browser.type(
      "textarea[name=prompt]",
      "Delegate the permission probe",
    );
    await browser.key("Enter");
    const children = await waitFor(
      () =>
        f.oc.request<{ id: string; title: string }[]>(
          `/session/${session.id}/children`,
        ),
      (children) => children.length > 0,
      60_000,
    );
    await browser.poll(
      `document.querySelector('.otk-permission-child')?.textContent.includes(${
        JSON.stringify(children[0].title)
      }) && document.querySelector('.otk-permission-command')?.textContent === 'echo otk'`,
      60_000,
    );
    await browser.poll(
      `!!document.querySelector('[data-session="${children[0].id}"]')`,
    );
    assertEquals(
      await browser.evaluate(
        `document.querySelector('[data-session="${
          children[0].id
        }"]')?.closest('li')?.dataset.parent`,
      ),
      session.id,
    );
    await capture(browser, f.oc.root, "e4-child-permission");
    await clickText(browser, "Allow once");
    await browser.poll(
      `!document.querySelector('.otk-permission-dock') && document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle'`,
      60_000,
    );
    assert(
      sentFrames(browser).some(({ frame }) =>
        frame.method === "permission.reply" &&
        (frame.params as { sessionID: string }).sessionID === children[0].id
      ),
    );
  } finally {
    await f.stop();
  }
});
Deno.test("web permission snapshot on reopen, focused keys, always confirmation and rejection message", async () => {
  const f = await browserFixture();
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Permission choices" },
    });
    const other = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Other session" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, other.id);
    f.fake.queue(bash(), { chunks: ["Always completed"] });
    await f.oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Ask while not viewed" }] },
    });
    await waitFor(
      () => f.oc.request<{ sessionID: string }[]>("/permission"),
      (requests) => requests.some((p) => p.sessionID === session.id),
    );
    await openSession(browser, session.id);
    await browser.poll("!!document.querySelector('.otk-permission-dock')");
    await browser.click(".otk-permission-dock h2");
    await browser.key("2");
    await browser.poll(
      "document.querySelector('.otk-permission-confirm')?.textContent.includes('echo *')",
    );
    assertEquals(
      sentFrames(browser).filter(({ frame }) =>
        frame.method === "permission.reply"
      ).length,
      0,
    );
    await capture(browser, f.oc.root, "permission-always-confirm");
    await clickText(browser, "Confirm allow always");
    await browser.poll(
      `!document.querySelector('.otk-permission-dock') && document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle'`,
      60_000,
    );
    f.fake.queue(bash("echo covered"), {
      chunks: ["Covered command completed"],
    });
    await browser.type(
      "textarea[name=prompt]",
      "Use the approved echo pattern",
    );
    await browser.key("Enter");
    await browser.poll(
      `!document.querySelector('.otk-permission-dock') && [...document.querySelectorAll('[data-tool-status=completed]')].some(el=>el.textContent.includes('echo covered')) && document.querySelector('[data-session="${session.id}"]').dataset.status === 'idle'`,
      60_000,
    );
    assertEquals(
      sentFrames(browser).filter(({ frame }) =>
        frame.method === "permission.reply"
      ).length,
      1,
    );
    f.fake.queue(bash("printf rejected"), { chunks: ["Rejection handled"] });
    await browser.type("textarea[name=prompt]", "Ask for a different command");
    await browser.key("Enter");
    await browser.poll(
      "document.querySelector('.otk-permission-command')?.textContent === 'printf rejected'",
    );
    await browser.click(".otk-permission-dock h2");
    await browser.key("3");
    await browser.poll("!!document.querySelector('textarea[name=rejection]')");
    await browser.type(
      "textarea[name=rejection]",
      "Please use another approach",
    );
    await browser.dialog(
      () => browser.click(`[data-session="${other.id}"]`),
      false,
    );
    await browser.poll(
      `location.hash.endsWith('/${session.id}') && document.querySelector('textarea[name=rejection]').value === 'Please use another approach'`,
    );
    await capture(browser, f.oc.root, "permission-reject-message");
    await clickText(browser, "Reject request");
    await browser.poll(
      "!document.querySelector('.otk-permission-dock') && !!document.querySelector('[data-tool-status=denied]') && getComputedStyle(document.querySelector('[data-tool-status=denied] .otk-tool-summary')).textDecorationLine.includes('line-through')",
      60_000,
    );
    const replies = sentFrames(browser).filter(({ frame }) =>
      frame.method === "permission.reply"
    ).map(({ frame }) => frame.params);
    assert(
      replies.some((input) => (input as { reply: string }).reply === "always"),
    );
    assert(
      replies.some((input) =>
        (input as { reply: string; message?: string }).reply === "reject" &&
        (input as { message?: string }).message ===
          "Please use another approach"
      ),
    );
  } finally {
    await f.stop();
  }
});
