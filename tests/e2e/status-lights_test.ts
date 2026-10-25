// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { TaskRecord } from "@otk/protocol";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { inboxBrowserFixture } from "../support/inbox-browser.ts";
import { WsClient } from "../support/ws-client.ts";
import { openSession } from "../support/browser-fixture.ts";

for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`attention-first project and task lamps, all activity visible in ${theme}`, async () => {
    const root = await fixture(),
      f = await inboxBrowserFixture(root),
      b = await Cdp.launch(root),
      c = new WsClient(f.url);
    const directory = f.entries[0].directory;
    const project = `.otk-project-row[data-project=${
      JSON.stringify(directory)
    }]`;
    const light = (selector: string) =>
      `document.querySelector(${
        JSON.stringify(selector + " .otk-status-light")
      })`;
    try {
      await c.connect();
      for (const entry of f.entries.slice(0, 4)) {
        await c.rpc("projects.visit", {
          directory: entry.directory,
          active: true,
        });
      }
      for (
        const [id, title] of [
          ["running", "Working"],
          ["done", "Review ready"],
          ["blocked", "Needs you"],
        ]
      ) {
        f.add({ ...f.entries[0], id, title });
      }
      const task = await c.rpc<TaskRecord>("tasks.create", {
        directory,
        name: "Review",
        sessions: ["otk", "running", "done"],
      });
      // Individual idle / green / amber / red tabs alongside the mixed task.
      for (
        const [id, name] of [["idle-tab", "Quiet"], ["green-tab", "Working"], [
          "amber-tab",
          "Finished",
        ]]
      ) {
        f.add({ ...f.entries[0], id, title: name });
        await c.rpc("tasks.create", { directory, name, sessions: [id] });
      }
      await c.rpc("prefs.set", { key: "theme", value: theme });
      await c.rpc("prefs.set", { key: "animationsOff", value: true });
      await c.rpc("prefs.set", { key: "notify.toast", value: false });
      await b.goto(f.url);
      await openSession(b, "otk");
      assert(
        await b.evaluate(
          "!!document.querySelector('.otk-server-status .otk-connection-light[data-connection-state=connected]') && !document.querySelector('.otk-server-status .otk-status-light')",
        ),
        "Healthy connection must use its own connected indicator, never a session attention state",
      );
      f.update("running", { status: "busy" });
      f.update("green-tab", { status: "busy" });
      f.update("done", { status: "busy" });
      f.update("done", { status: "idle" });
      f.update("amber-tab", { status: "busy" });
      f.update("amber-tab", { status: "idle" });
      const attention = {
        permissions: 1,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      };
      f.update("blocked", { attention });
      // Sidebar also presents all four states.
      f.update("atmosphera", { status: "busy" });
      f.update("globnotes", { status: "busy" });
      f.update("globnotes", { status: "idle" });
      const tab = `[data-tab=${JSON.stringify(task.id)}]`;
      await b.poll(`${light(tab)}?.dataset.state==='finished'`);
      await b.poll(`${light(project)}?.dataset.state==='blocked'`);
      for (const state of ["blocked", "finished", "working", "idle"]) {
        await b.poll(
          `!!document.querySelector(${
            JSON.stringify(
              `.otk-inbox-scroll .otk-status-light[data-state=${state}]`,
            )
          })`,
        );
        const selector =
          `.otk-project-tabs [role=tab] .otk-status-light[data-state=${state}]`;
        await b.poll(`!!document.querySelector(${JSON.stringify(selector)})`);
        assert(
          await b.evaluate(
            `(()=>{const r=document.querySelector(${
              JSON.stringify(selector)
            }).getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`,
          ),
        );
        const paints = await b.evaluate<
          { gel: string; token: string; body: string }[]
        >(
          `[...document.querySelectorAll('.otk-project-inbox .otk-status-light[data-state=${state}], .otk-project-tabs [role=tab] .otk-status-light[data-state=${state}]')].map(el=>({gel:getComputedStyle(el).getPropertyValue('--lamp-color').trim(),token:getComputedStyle(document.documentElement).getPropertyValue('--otk-lamp-${state}').trim(),body:getComputedStyle(el.querySelector('.otk-lamp-body')).backgroundImage}))`,
        );
        assert(paints.length >= 2);
        for (const paint of paints) {
          assert(/^#[\da-f]{6}$/i.test(paint.token), JSON.stringify(paint));
          assertEquals(paint.gel, paint.token);
          assert(paint.body.includes("gradient"));
        }
      }
      await b.evaluate("document.fonts.ready");
      const connectionPaint = await b.evaluate<
        { color: string; token: string }
      >("(()=>{const el=document.querySelector('.otk-server-status .otk-connection-light');return {color:getComputedStyle(el).getPropertyValue('--connection-color').trim(),token:getComputedStyle(document.documentElement).getPropertyValue('--otk-connection-connected').trim()}})()");
      assertEquals(connectionPaint.color, connectionPaint.token);
      assert(/^#[\da-f]{6}$/i.test(connectionPaint.token));
      if (Deno.env.get("OTK_STATUS_LIGHT_SHOTS")) {
        await b.screenshot(join(root, `lights-r2-${theme}.png`));
      }
      const shots = Deno.env.get("OTK_NITS_SHOTS");
      if (shots) await b.screenshot(join(shots, `nits-steady-${theme}.png`));
      await c.rpc("prefs.set", { key: "animationsOff", value: false });
      await b.poll(
        "getComputedStyle(document.querySelector('.otk-project-tabs [data-state=working] .otk-lamp-glow')).animationName==='otk-lamp-breathe'",
      );
      const cycle = await b.evaluate<
        {
          duration: number;
          iterations: string;
          progressing: boolean;
          bodySteady: boolean;
          shadows: string[];
          green: boolean;
        }
      >(`(async()=>{
        const lamp=document.querySelector('.otk-project-tabs [data-state=working]');
        const glow=lamp.querySelector('.otk-lamp-glow'), body=lamp.querySelector('.otk-lamp-body');
        const animation=glow.getAnimations()[0], timing=animation.effect.getTiming();
        const start=animation.currentTime, paint=getComputedStyle(body).cssText+getComputedStyle(body).backgroundImage;
        await new Promise(r=>setTimeout(r,160));
        const progressing=animation.currentTime>start;
        animation.pause();
        const shadows=[];
        for(const time of [0,1300,2600]) {animation.currentTime=time;await new Promise(requestAnimationFrame);shadows.push(getComputedStyle(glow).boxShadow)}
        const token=getComputedStyle(lamp).getPropertyValue('--lamp-color').trim();
        const rgb=[1,3,5].map(i=>parseInt(token.slice(i,i+2),16));
        return {duration:timing.duration,iterations:String(timing.iterations),progressing,bodySteady:paint===getComputedStyle(body).cssText+getComputedStyle(body).backgroundImage,shadows,green:rgb[1]>rgb[0]&&rgb[1]>rgb[2]};
      })()`);
      assert(cycle.green, "Working must use a green theme token");
      assertEquals(cycle.duration, 2600);
      assertEquals(cycle.iterations, "Infinity");
      assert(cycle.progressing && cycle.bodySteady);
      assert(cycle.shadows[0] !== cycle.shadows[1]);
      assertEquals(cycle.shadows[0], cycle.shadows[2]);
      for (const [frame, time] of [["trough", 0], ["peak", 1300]] as const) {
        await b.evaluate(
          `(async()=>{for(const el of document.querySelectorAll('.otk-status-light[data-state=working] .otk-lamp-glow')){const a=el.getAnimations()[0];a.pause();a.currentTime=${time}}await new Promise(requestAnimationFrame)})()`,
        );
        if (shots) {
          await b.screenshot(join(shots, `nits-${frame}-${theme}.png`));
        }
      }
      await b.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      await b.poll(
        "getComputedStyle(document.querySelector('.otk-project-tabs [data-state=working] .otk-lamp-glow')).animationName==='none'",
      );
      const steady =
        "(()=>{const s=getComputedStyle(document.querySelector('.otk-project-tabs [data-state=working] .otk-lamp-glow'));return {shadow:s.boxShadow,opacity:s.opacity}})()";
      const reduced = await b.evaluate(steady);
      assert((reduced as { shadow: string }).shadow !== "none");
      await b.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
      });
      await c.rpc("prefs.set", { key: "animationsOff", value: true });
      await b.poll(
        "getComputedStyle(document.querySelector('.otk-project-tabs [data-state=working] .otk-lamp-glow')).animationName==='none'",
      );
      assertEquals(
        await b.evaluate(steady),
        reduced,
        "Both motion settings retain the same steady glow",
      );
      await c.rpc("prefs.set", { key: "reducedColors", value: true });
      await b.poll(
        "document.documentElement.hasAttribute('data-otk-reduced-colors')",
      );
      for (
        const [state, shape, label] of [
          ["blocked", "×", "Needs you"],
          ["finished", "✓", "Finished, not seen"],
          ["working", "◐", "Working"],
          ["idle", "○", "Idle"],
        ]
      ) {
        const lamp =
          `.otk-project-tabs [role=tab] .otk-status-light[data-state=${state}]`;
        assertEquals(
          await b.evaluate(
            `(()=>{const el=document.querySelector(${
              JSON.stringify(lamp)
            });return {shape:el.textContent.trim(),label:el.getAttribute('aria-label'),display:getComputedStyle(el.querySelector('.otk-lamp-shape')).display,body:getComputedStyle(el.querySelector('.otk-lamp-body')).display}})()`,
          ),
          { shape, label, display: "block", body: "none" },
        );
      }
      await c.rpc("prefs.set", { key: "reducedColors", value: false });
      await c.rpc("tasks.addSession", { id: task.id, sessionID: "blocked" });
      await b.poll(`${light(tab)}?.dataset.state==='blocked'`);
      // Once the blocking request resolves, the unseen finish outranks work in
      // both aggregate consumers, including after reload and in the sidebar rail.
      f.update("blocked", { attention: { ...attention, permissions: 0 } });
      for (let reload = 0; reload < 2; reload++) {
        if (reload) await b.reload();
        await b.poll(`${light(tab)}?.dataset.state==='finished'`);
        await b.poll(`${light(project)}?.dataset.state==='finished'`);
      }
      await b.click('[aria-label="Collapse projects"]');
      await b.poll(
        "document.querySelector('.otk-project-inbox').dataset.collapsed==='true'",
      );
      await b.poll(`${light(project)}?.dataset.state==='finished'`);
      await b.poll(
        "!!document.querySelector('.otk-server-status .otk-connection-light[data-connection-state=connected]')",
      );
      f.app.connections.connection("reconnecting");
      await b.poll(
        "!!document.querySelector('.otk-server-status .otk-connection-light[data-connection-state=reconnecting]')",
      );
      f.app.connections.connection("connected");
      await b.click(".otk-settings-entry");
      await b.poll(
        "!!document.querySelector('.otk-settings .otk-connection-light[data-connection-state=connected]')",
      );
      f.app.connections.connection("connecting");
      await b.poll(
        "!!document.querySelector('.otk-settings .otk-connection-light[data-connection-state=connecting]')",
      );
      f.app.connections.connection("reconnecting");
      await b.poll(
        "!!document.querySelector('.otk-settings .otk-connection-light[data-connection-state=reconnecting]')",
      );
      f.app.connections.connection("connected");
      await b.poll(
        "!!document.querySelector('.otk-settings .otk-connection-light[data-connection-state=connected]')",
      );
      assertEquals(b.errors, []);
    } finally {
      await c.close();
      await b.close();
      await f.app.stop();
    }
  });
}
