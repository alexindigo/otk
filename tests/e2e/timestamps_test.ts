// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { SidecarTest } from "../support/sidecar.ts";
// Sample the rendered colour, including translucent ink and ancestor surfaces.
// Reading RGB from a transparent canvas discards the alpha-based hierarchy.
const renderedColors = `
  const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
  const ctx=canvas.getContext('2d');
  const color=(element,property='color')=>{
    ctx.clearRect(0,0,1,1);
    const layers=[];for(let node=element;node;node=node.parentElement)layers.unshift(node);
    for(const node of layers){ctx.fillStyle=getComputedStyle(node).backgroundColor;ctx.fillRect(0,0,1,1)}
    ctx.fillStyle=getComputedStyle(element)[property];ctx.fillRect(0,0,1,1);
    return [...ctx.getImageData(0,0,1,1).data].slice(0,3);
  };
`;
test("creation-time hover and persistent visibility, structural footer date/clock, native final time and completed restart", async () => {
  const f = await browserFixture();
  let server: SidecarTest | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Message timestamps" },
    });
    server = await SidecarTest.start(f.oc);
    const port = server.port, url = server.url, browser = await f.browser(url);
    await openSession(browser, session.id);
    f.fake.queue({
      chunks: ["first output", " then more", " and more", " final output"],
      delay: 1000,
    });
    await browser.type("textarea[name=prompt]", "Show timestamp behavior");
    await browser.key("Enter");
    await browser.poll(
      "!!document.querySelector('.otk-last-output-time') && document.querySelector('[data-role=assistant] .otk-text')?.textContent.includes('first output')",
    );
    const first = await browser.evaluate<string>(
      "document.querySelector('.otk-last-output-time').dateTime",
    );
    await browser.poll(
      `document.querySelector('.otk-last-output-time').dateTime!==${
        JSON.stringify(first)
      }`,
    );
    await browser.poll(
      `document.querySelector('[data-session="${session.id}"]').dataset.status==='idle' && document.querySelector('[data-role=assistant] .otk-text').textContent.includes('final output')`,
    );
    const raw = await f.oc.request<
      {
        info: { role: string; time: { completed?: number; created: number } };
        parts: {
          type: string;
          time?: { end?: number };
          state?: { time?: { end?: number } };
        }[];
      }[]
    >(`/session/${session.id}/message`);
    const reply = raw.find((row) =>
      row.info.role === "assistant" && row.info.time.completed
    )!;
    const ends = reply.parts.flatMap((part) =>
      part.type === "text" || part.type === "reasoning"
        ? [part.time?.end || 0]
        : part.type === "tool"
        ? [part.state?.time?.end || 0]
        : []
    ).filter((end) => end > 0);
    const expected = ends.length
      ? Math.max(...ends)
      : reply.info.time.completed || reply.info.time.created;
    await browser.poll(
      `Date.parse(document.querySelector('.otk-last-output-time').dateTime)===${expected}`,
    );
    await browser.screenshot(join(f.oc.root, "timestamps-default.png"));
    const before = await browser.evaluate<{ left: number; right: number }>(
      "(()=>{const r=document.querySelector('.otk-last-output-time').getBoundingClientRect();return {left:r.left,right:r.right}})()",
    );
    assertEquals(
      await browser.evaluate(
        "getComputedStyle(document.querySelector('.otk-last-output-date')).visibility",
      ),
      "hidden",
    );
    const point = await browser.evaluate<{ x: number; y: number }>(
      "(()=>{const el=document.querySelector('.otk-last-output-time');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...point,
    });
    await browser.poll(
      "getComputedStyle(document.querySelector('.otk-last-output-date')).visibility==='visible'",
    );
    const geometry = await browser.evaluate<
      {
        dateRight: number;
        timeLeft: number;
        timeRight: number;
        dateCenter: number;
        timeCenter: number;
        date: string;
        expected: string;
      }
    >("(()=>{const date=document.querySelector('.otk-last-output-date'),time=document.querySelector('.otk-last-output-time'),d=date.getBoundingClientRect(),t=time.getBoundingClientRect();return {dateRight:d.right,timeLeft:t.left,timeRight:t.right,dateCenter:d.y+d.height/2,timeCenter:t.y+t.height/2,date:date.textContent.trim(),expected:new Date(time.dateTime).toLocaleDateString()}})()");
    assertEquals(geometry.date, geometry.expected);
    assert(geometry.dateRight < geometry.timeLeft);
    assert(Math.abs(geometry.dateCenter - geometry.timeCenter) < .5);
    assert(
      Math.abs(geometry.timeLeft - before.left) < .5 &&
        Math.abs(geometry.timeRight - before.right) < .5,
    );
    await browser.screenshot(
      join(f.oc.root, "timestamps-hover-output-date.png"),
    );
    // transcript_test covers the work-fold divider's width, style and contrast.
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 10,
      y: 10,
    });
    await browser.poll(
      "getComputedStyle(document.querySelector('.otk-last-output-date')).visibility==='hidden'",
    );
    for (const role of ["user", "assistant"]) {
      assertEquals(
        await browser.evaluate(
          `getComputedStyle(document.querySelector('[data-role=${role}] .otk-created-time')).visibility`,
        ),
        "hidden",
      );
      const p = await browser.evaluate<{ x: number; y: number }>(
        `(()=>{const el=document.querySelector('[data-role=${role}] .otk-created-trigger');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
      );
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...p,
      });
      await browser.poll(
        `getComputedStyle(document.querySelector('[data-role=${role}] .otk-created-time')).visibility==='visible'`,
      );
      await browser.screenshot(join(f.oc.root, `timestamps-hover-${role}.png`));
      await browser.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 10,
        y: 10,
      });
      await browser.poll(
        `getComputedStyle(document.querySelector('[data-role=${role}] .otk-created-time')).visibility==='hidden'`,
      );
    }
    const style = await browser.evaluate<
      {
        footerRight: number;
        timeRight: number;
        detailsRight: number;
        timeLeft: number;
        footerColor: string;
        timeColor: string;
        roleColor: number[];
        createdColor: number[];
      }
    >(`(()=>{${renderedColors}const footer=document.querySelector('.otk-message-footer'),t=footer.querySelector('.otk-last-output-time'),d=footer.querySelector('.otk-message-details');return {footerRight:footer.getBoundingClientRect().right,timeRight:t.getBoundingClientRect().right,detailsRight:d.getBoundingClientRect().right,timeLeft:t.getBoundingClientRect().left,footerColor:getComputedStyle(footer).color,timeColor:getComputedStyle(t).color,roleColor:color(document.querySelector('.otk-created-trigger')),createdColor:color(document.querySelector('.otk-created-time'))}})()`);
    assert(Math.abs(style.footerRight - style.timeRight) < .5);
    assert(style.detailsRight < style.timeLeft);
    assertEquals(style.footerColor, style.timeColor);
    assert(
      style.createdColor.reduce((a, b) => a + b, 0) <
        style.roleColor.reduce((a, b) => a + b, 0),
    );
    await browser.click("[data-role=assistant] .otk-created-trigger");
    await browser.key("Tab");
    await browser.poll(
      "document.activeElement===document.querySelector('.otk-turn-usage > button') && !!document.querySelector('.otk-turn-usage :popover-open')",
    );
    await browser.key("Tab");
    await browser.poll(
      `document.activeElement===document.querySelector('[data-message-command="reply.fork"]')`,
    );
    await browser.key("Tab");
    await browser.poll(
      "document.activeElement===document.querySelector('.otk-copy-message')",
    );
    await browser.key("Tab");
    await browser.poll(
      "document.activeElement===document.querySelector('.otk-last-output-time') && getComputedStyle(document.querySelector('.otk-last-output-date')).visibility==='visible'",
    );
    await browser.key("Tab", 8);
    await browser.key("Tab", 8);
    await browser.key("Tab", 8);
    await browser.key("Tab", 8);
    await browser.poll(
      "document.activeElement===document.querySelector('[data-role=assistant] .otk-created-trigger') && getComputedStyle(document.querySelector('[data-role=assistant] .otk-created-time')).visibility==='visible'",
    );
    await browser.click(".otk-display-menu > button");
    await browser.poll(
      "document.querySelector('.otk-display-menu').textContent.includes('Always show timestamps')",
    );
    await browser.click("input[name=timestamps]");
    await browser.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 10,
      y: 10,
    });
    await browser.poll(
      "[...document.querySelectorAll('.otk-created-time')].every(el=>getComputedStyle(el).visibility==='visible')",
    );
    await browser.screenshot(join(f.oc.root, "timestamps-always-visible.png"));
    const completed = await browser.evaluate<string>(
      "document.querySelector('.otk-last-output-time').dateTime",
    );
    await browser.reload();
    await browser.poll(
      `document.querySelector('.otk-last-output-time')?.dateTime===${
        JSON.stringify(completed)
      } && [...document.querySelectorAll('.otk-created-time')].length===2 && [...document.querySelectorAll('.otk-created-time')].every(el=>getComputedStyle(el).visibility==='visible')`,
    );
    const db = new DatabaseSync(join(f.oc.root, `otk-${port}`, "otk.db"), {
      readOnly: true,
    });
    try {
      assertEquals(
        db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='output_times'",
        ).all(),
        [],
      );
      assertEquals(
        db.prepare(
          "SELECT feature,version FROM otk_migrations ORDER BY feature",
        ).all(),
        [
          { feature: "finishes", version: 1 },
          { feature: "frecency", version: 1 },
          { feature: "permissions", version: 1 },
          { feature: "prefs", version: 1 },
          { feature: "project-templates", version: 1 },
          { feature: "project-templates", version: 2 },
          { feature: "projects", version: 1 },
          { feature: "seen", version: 1 },
          { feature: "tasks", version: 1 },
        ],
      );
    } finally {
      db.close();
    }
    await server.stop();
    server = undefined;
    server = await SidecarTest.start(f.oc, {
      server: { port },
      state: { path: join(f.oc.root, `otk-${port}`) },
    });
    await browser.poll(
      `document.querySelector('.otk-server-status[data-connection=local]').title.includes(': connected;') && document.querySelector('.otk-last-output-time')?.dateTime===${
        JSON.stringify(completed)
      }`,
      60000,
    );
  } finally {
    await server?.stop();
    await f.stop();
  }
});
