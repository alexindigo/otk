// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { fixture } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("appearance settings persist, broadcast and paint real session status lights", async () => {
  const f = await browserFixture();
  let client: WsClient | undefined;
  try {
    const seed = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Visual system" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await openSession(browser, seed.id);
    const light = `[data-session="${seed.id}"] .otk-status-light`;
    await browser.poll(
      `document.querySelector('${light}')?.dataset.state === 'idle'`,
    );
    await browser.poll(
      "document.fonts.ready.then(()=>document.fonts.check('13px \"IBM Plex Sans\"'))",
    );
    assertEquals(
      await browser.evaluate(
        "getComputedStyle(document.querySelector('textarea[name=prompt]')).fontFamily",
      ),
      '"IBM Plex Sans", sans-serif',
    );
    const reply = f.fake.queueHeld({
      chunks: ["Working with the visual system.", " Finished."],
      delay: 900,
    });
    await browser.type("textarea[name=prompt]", "Show the working light");
    await browser.key("Enter");
    await browser.poll(
      `document.querySelector('${light}')?.dataset.state === 'working'`,
    );
    reply.release();
    await browser.poll(
      `document.querySelector('${light}')?.dataset.state === 'idle'`,
    );
    await browser.click(".otk-settings-entry");
    await browser.poll(
      "!!document.querySelector('input[name=reducedColors]:not(:disabled)')",
    );
    const other = await f.browser(server.url);
    for (const key of ["reducedColors", "animationsOff"]) {
      await browser.click(`input[name=${key}]`);
      const attr = key === "reducedColors"
        ? "data-otk-reduced-colors"
        : "data-otk-animations-off";
      await browser.poll(`document.documentElement.hasAttribute('${attr}')`);
      await other.poll(`document.documentElement.hasAttribute('${attr}')`);
    }
    const prefs = await client.rpc("prefs.get", {}) as Record<string, unknown>;
    assertEquals(prefs.reducedColors, true);
    assertEquals(prefs.animationsOff, true);
    await browser.reload();
    await browser.poll(
      "document.documentElement.hasAttribute('data-otk-reduced-colors') && document.documentElement.hasAttribute('data-otk-animations-off')",
    );
    await openSession(browser, seed.id);
    assertEquals(
      await browser.evaluate(
        `getComputedStyle(document.querySelector('${light} .otk-lamp-shape')).display`,
      ),
      "block",
    );
    assertEquals(
      await browser.evaluate(
        `getComputedStyle(document.querySelector('${light} .otk-lamp-body')).display`,
      ),
      "none",
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});

Deno.test("public lights render all states, fixed gel colours, sizing, event blink, breathing and motion suppression; reduced colours shapes and ageing", async () => {
  const root = await fixture(), dist = join(root, "dist");
  const build = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.2.0",
      "build",
      "--config",
      "tests/reuse/ui-consumer/vite.config.ts",
      "--outDir",
      dist,
      "--logLevel",
      "warn",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(build.code, 0, new TextDecoder().decode(build.stderr));
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const pathname = new URL(request.url).pathname;
      const file = join(dist, pathname === "/" ? "index.html" : pathname);
      try {
        return new Response(await Deno.readFile(file), {
          headers: {
            "content-type": file.endsWith(".js")
              ? "text/javascript"
              : file.endsWith(".css")
              ? "text/css"
              : file.endsWith(".woff2")
              ? "font/woff2"
              : "text/html",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  );
  let browser: Cdp | undefined;
  try {
    browser = await Cdp.launch(root);
    await browser.goto(`http://127.0.0.1:${server.addr.port}`);
    await browser.poll(
      "document.querySelectorAll('[data-visual-gallery] .otk-status-light').length === 5",
    );
    const probe =
      `(() => [...document.querySelectorAll('[data-visual-gallery] .otk-status-light')].map(el=>{
      const body=getComputedStyle(el.querySelector('.otk-lamp-body')),glow=getComputedStyle(el.querySelector('.otk-lamp-glow')),shape=getComputedStyle(el.querySelector('.otk-lamp-shape')),r=el.getBoundingClientRect();
      return {state:el.dataset.state,label:el.getAttribute('aria-label'),title:el.title,size:r.width,height:r.height,color:getComputedStyle(el).getPropertyValue('--lamp-color').trim(),rim:body.borderTopColor,socket:body.boxShadow,body:body.display,shape:shape.display,glyph:el.querySelector('.otk-lamp-shape').textContent,fg:shape.color,breathe:glow.animationName,duration:glow.animationDuration,blink:body.animationName,glow:glow.display,gradient:body.backgroundImage};
    }))()`;
    type Light = {
      state: string;
      label: string;
      title: string;
      size: number;
      height: number;
      color: string;
      rim: string;
      socket: string;
      body: string;
      shape: string;
      glyph: string;
      fg: string;
      breathe: string;
      duration: string;
      blink: string;
      glow: string;
      gradient: string;
    };
    const dark = await browser.evaluate<Light[]>(probe);
    assertEquals(dark.map((lamp) => lamp.state), [
      "blocked",
      "working",
      "finished",
      "idle",
      "working",
    ]);
    assertEquals(dark.map((lamp) => lamp.size), [10, 10, 10, 10, 8]);
    for (const lamp of dark) {
      assertEquals(lamp.size, lamp.height);
      assertEquals(lamp.title, lamp.label);
      assert(lamp.label.length > 0);
      assertEquals(lamp.rim, "rgb(162, 171, 183)");
      assert(lamp.socket.includes("rgb(26, 28, 30)"));
    }
    assert(dark[0].gradient.includes("linear-gradient"));
    assertEquals(dark[1].breathe, "otk-lamp-breathe");
    assertEquals(dark[1].duration, "1.1s");
    assertEquals(dark[3].glow, "none");
    assertEquals(dark[0].blink, "none");
    const breathing = await browser.evaluate<number[]>(`(() => {
      const lamp=document.querySelector('[data-visual-gallery] [data-state=working]'),glow=lamp.querySelector('.otk-lamp-glow'),body=lamp.querySelector('.otk-lamp-body'),animation=glow.getAnimations()[0];
      animation.pause();animation.currentTime=0;const low=Number(getComputedStyle(glow).opacity),steady=Number(getComputedStyle(body).opacity);
      animation.currentTime=550;const high=Number(getComputedStyle(glow).opacity),still=Number(getComputedStyle(body).opacity);animation.play();return [low,high,steady,still];
    })()`);
    assert(breathing[1] - breathing[0] > .3);
    assertEquals(
      breathing.slice(2),
      [1, 1],
      "The marble stays steady while only its glow breathes",
    );
    await browser.click("[data-light-event]");
    await browser.poll(
      "document.querySelector('[data-visual-gallery] .otk-status-light').hasAttribute('data-blink')",
    );
    assertEquals(
      (await browser.evaluate<Light[]>(probe))[0].blink,
      "otk-lamp-blink",
    );
    const blink = await browser.evaluate<number[]>(`(() => {
      const body=document.querySelector('[data-visual-gallery] .otk-lamp-body'),animation=body.getAnimations()[0];animation.pause();
      animation.currentTime=90;const dip=Number(getComputedStyle(body).opacity);animation.currentTime=250;const restored=Number(getComputedStyle(body).opacity);animation.play();return [dip,restored];
    })()`);
    assert(Math.abs(blink[0] - .2) < .01);
    assertEquals(blink[1], 1);
    await browser.poll(
      "!document.querySelector('[data-visual-gallery] .otk-status-light').hasAttribute('data-blink')",
    );
    await browser.click("[data-light]");
    await browser.poll(
      "document.documentElement.dataset.otkTheme === 'otk-light'",
    );
    const light = await browser.evaluate<Light[]>(probe);
    assertEquals(
      light.filter((lamp) => lamp.state !== "idle").map((lamp) => lamp.color),
      dark.filter((lamp) => lamp.state !== "idle").map((lamp) => lamp.color),
    );
    assertEquals(light[0].rim, "rgb(82, 88, 96)");
    assertEquals(light[0].socket, dark[0].socket);
    for (const reduced of ["setting", "system"]) {
      if (reduced === "setting") {
        await browser.evaluate(
          "document.documentElement.setAttribute('data-otk-animations-off','')",
        );
      } else {
        await browser.evaluate(
          "document.documentElement.removeAttribute('data-otk-animations-off')",
        );
        await browser.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: "reduce" }],
        });
      }
      await browser.click("[data-light-event]");
      await browser.poll(
        "document.querySelector('[data-visual-gallery] .otk-status-light').hasAttribute('data-blink')",
      );
      for (const lamp of await browser.evaluate<Light[]>(probe)) {
        assertEquals(lamp.breathe, "none");
        assertEquals(lamp.blink, "none");
      }
      assertEquals(
        await browser.evaluate(
          "document.querySelector('[data-visual-gallery]').getAnimations({subtree:true}).length",
        ),
        0,
      );
      await browser.poll(
        "!document.querySelector('[data-visual-gallery] .otk-status-light').hasAttribute('data-blink')",
      );
    }
    await browser.evaluate(
      "document.documentElement.setAttribute('data-otk-reduced-colors','')",
    );
    const shapes = await browser.evaluate<Light[]>(probe);
    assertEquals(shapes.slice(0, 4).map((lamp) => lamp.glyph), [
      "×",
      "◐",
      "✓",
      "○",
    ]);
    for (const lamp of shapes) {
      assertEquals(lamp.body, "none");
      assertEquals(lamp.shape, "block");
      assertEquals(lamp.fg, "rgb(26, 28, 30)");
    }
    assertEquals(
      await browser.evaluate(
        "[...document.querySelectorAll('[data-age]')].map(el=>[getComputedStyle(el).color,getComputedStyle(el).textDecorationStyle,getComputedStyle(el).textDecorationLine])",
      ),
      [
        ["rgb(26, 28, 30)", "solid", "none"],
        ["rgb(26, 28, 30)", "dotted", "underline"],
        ["rgb(26, 28, 30)", "wavy", "underline"],
        ["rgb(26, 28, 30)", "double", "underline"],
      ],
    );
    for (const mode of ["dark", "light"]) {
      await browser.click(`[data-${mode}]`);
      await browser.poll(
        `document.documentElement.dataset.otkTheme === 'otk-${mode}'`,
      );
      const ratios = await browser.evaluate<number[]>(`(() => {
        const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');canvas.width=canvas.height=1;
        const sample=document.createElement('span');document.body.append(sample);
        const rgb=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>v/255)};
        const color=value=>{sample.style.color=value;return rgb(getComputedStyle(sample).color)};
        const luminance=c=>c.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
        const ratio=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
        const fill=color('var(--otk-action)'),on=color('var(--otk-action-on)'),text=color('var(--otk-action-text)'),focus=color('var(--otk-action-focus)');
        const results=[ratio(fill,on)];
        for(const surface of ['bg','bg-side','surface','surface-2']) {
          const bg=color('var(--otk-'+surface+')');
          results.push(ratio(text,bg),ratio(focus,bg));
        }
        sample.remove();return results;
      })()`);
      assert(ratios[0] >= 4.5, `${mode} reduced CTA label`);
      for (let i = 1; i < ratios.length; i++) {
        assert(
          ratios[i] >= (i % 2 ? 4.5 : 3),
          `${mode} reduced action pair ${i}: ${ratios[i]}`,
        );
      }
    }
    assertEquals(browser.errors, []);
  } finally {
    await browser?.close();
    await server.shutdown();
  }
});
