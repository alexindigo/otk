// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { AgentOption, AssistantMessage } from "@otk/protocol";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";

test("neutral backend facts reach reply, agent picker, task and truncation consumers in both themes", async () => {
  const workspace = await fixture(), root = join(workspace, "backend-facts");
  await Deno.mkdir(root);
  // JSON represents a neutral external backend, including absent optional data.
  const options: AgentOption[] = JSON.parse(JSON.stringify([
    { name: "action", color: "accent" },
    { name: "alternate", color: "secondary" },
    { name: "literal", color: "#12abEF" },
    { name: "uncoloured" },
  ]));
  const reply: AssistantMessage = JSON.parse(JSON.stringify({
    id: "reply",
    sessionID: "core",
    role: "assistant",
    agent: "action",
    agentColor: "accent",
    model: { provider: "external", model: "fixture" },
    time: { created: 2000, completed: 6000 },
    tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    parts: [{
      id: "task",
      kind: "tool",
      call: {
        tool: "task",
        callID: "task",
        status: "completed",
        awaitingPermission: false,
        time: { start: 2000, end: 3000 },
        description: "Inspect the result",
        toolCount: 0,
        childSessionID: "child",
      },
    }, {
      id: "external",
      kind: "tool",
      call: {
        tool: "external",
        name: "external-preview",
        callID: "external",
        status: "completed",
        awaitingPermission: false,
        time: { start: 3000, end: 6000 },
        summary: "A backend-owned preview",
        output: "A short preview from another backend.",
        outputTruncated: true,
      },
    }],
  }));
  const f = await coreBackendFixture(root, {
    agents: { listAgents: () => Promise.resolve(options) },
    prompt: { prompt: () => Promise.resolve(), abort: () => Promise.resolve() },
  });
  f.app.backend.core.listMessages = () => Promise.resolve([reply]);
  const b = await Cdp.launch(workspace), client = new WsClient(f.url);
  const failures: unknown[] = [];
  const check = (run: () => void) => {
    try {
      run();
    } catch (error) {
      failures.push(error);
    }
  };
  try {
    await client.connect();
    await client.rpc("prefs.set", { key: "genericToolOutput", value: true });
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.goto(`${f.url}/#/local/core`);
    await b.poll(
      "!!document.querySelector('.otk-message-agent') && document.querySelector('.otk-composer-agent')?.textContent==='Action'",
    );
    // Applied defaults are intentionally muted; explicit choices expose colour.
    await b.click(".otk-agent-picker > button");
    await b.poll(
      "document.querySelectorAll('.otk-popover-panel:popover-open .otk-picker-name').length===4",
    );
    await b.click(
      '.otk-popover-panel:popover-open [data-picker-key="action"] .otk-picker-option',
    );
    await b.poll(
      "!document.querySelector('.otk-agent-picker > button').classList.contains('is-applied')",
    );
    await b.click("[data-tool=external] .otk-tool-toggle");
    await b.poll(
      "document.querySelector('[data-tool=external] .otk-tool-toggle')?.getAttribute('aria-expanded')==='true'",
    );
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      // Reply metadata exposes its agent colour on hover/focus, not at rest.
      await b.evaluate(
        "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
      );
      const point = await b.evaluate<{ x: number; y: number }>(
        "(()=>{const r=document.querySelector('.otk-message-agent').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
      );
      await b.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...point,
      });
      await b.poll(
        "document.querySelector('.otk-message-agent').matches(':hover')",
      );
      const observed = await b.evaluate<
        {
          task: string;
          notice: string;
          reply: string;
          trigger: string;
          accent: string;
        }
      >(`(()=>{
        const probe=document.createElement('span');probe.style.color='var(--accent)';document.body.append(probe);
        const accent=getComputedStyle(probe).color;probe.remove();
        return {task:document.querySelector('[data-tool=task] .otk-tool-target')?.textContent??'',
          notice:document.querySelector('[data-tool=external] small')?.textContent??'',
          reply:getComputedStyle(document.querySelector('.otk-message-agent')).color,
          trigger:getComputedStyle(document.querySelector('.otk-agent-picker > button')).color,accent};
      })()`);
      console.info(theme, observed);
      check(() => assertEquals(observed.task, "Unknown agent"));
      check(() => assertEquals(observed.notice, "Output truncated."));
      check(() => assertEquals(observed.reply, observed.accent));
      check(() => assertEquals(observed.trigger, observed.accent));
      const shots = Deno.env.get("OTK_BACKEND_FACTS_SHOTS");
      const capture = async (state: string) => {
        if (!shots) return;
        await Deno.mkdir(shots, { recursive: true });
        await b.evaluate(
          "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
        );
        await b.screenshot(join(shots, `${theme}-${state}.png`));
      };
      await capture("facts");
      await b.click(".otk-agent-picker > button");
      await b.poll(
        "!!document.querySelector('.otk-agent-picker .otk-popover-panel:popover-open')",
      );
      await b.poll(
        "document.querySelectorAll('.otk-popover-panel:popover-open .otk-picker-name').length===4",
      );
      const rows = await b.evaluate<{ expected: string; actual: string }[]>(
        `(()=>{
        const values=['var(--accent)','var(--secondary)','#12abEF'];
        return [...document.querySelectorAll('.otk-popover-panel:popover-open .otk-picker-name')].slice(0,3).map((el,i)=>{
          const probe=document.createElement('span');probe.style.color=values[i];document.body.append(probe);
          const expected=getComputedStyle(probe).color;probe.remove();return {expected,actual:getComputedStyle(el).color};
        });})()`,
      );
      check(() => {
        assertEquals(rows.length, 3);
        for (const row of rows) assertEquals(row.actual, row.expected);
      });
      await capture("picker");
      await b.key("Escape");
      await b.poll(
        "!document.querySelector('.otk-agent-picker .otk-popover-panel:popover-open')",
      );
    }
    assertEquals(b.errors, []);
    assert(
      !failures.length,
      JSON.stringify(
        failures.map((error) =>
          error instanceof Error ? error.message : String(error)
        ),
      ),
    );
  } finally {
    await b.close();
    await client.close();
    await f.app.stop();
  }
});
