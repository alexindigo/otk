// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";

interface SourceRow {
  id: number;
  top: number;
  height: number;
  key: string | null | undefined;
  message: string | null | undefined;
  text: string | undefined;
}
interface SourceFrame {
  at: number;
  step: number;
  top: number;
  total: number;
  height: number;
  count: string | null | undefined;
  rows: SourceRow[];
}
interface ScrollEvidence {
  frames: SourceFrame[];
  writes: {
    at: number;
    step: number;
    before: number;
    wanted: number;
    after: number;
    total: number;
    stack?: string;
  }[];
  events: {
    type: string;
    at: number;
    step: number;
    top: number;
    total: number;
    delta?: number;
    trusted: boolean;
  }[];
  step: number;
  active: boolean;
}
type ProbeGlobal = typeof globalThis & { invF: ScrollEvidence };

test.use({
  browserName: process.env.INV_F_BROWSER === "firefox" ? "firefox" : "chromium",
});

test(
  "messages.slow-upward-scroll-retains-visible-source",
  { tag: ["@messages", "@contracts", "@load"] },
  async ({ state, page }, info) => {
    test.setTimeout(240_000);
    const diagnostics: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("INVF_OWNER")) {
        diagnostics.push(message.text());
      }
    });
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "INV-F long transcript",
    });
    for (let n = 0; n < 16; n++) {
      const reply = Array.from(
        { length: 65 },
        (_, i) =>
          `${
            process.env.INV_F_LIST && i < 55 ? "- " : ""
          }Paragraph ${n}-${i}: The reader should keep this source in view. ` +
          "Measured identity geometry must preserve a stable visible anchor through nested window recycling. "
            .repeat(2 + i % 4),
      ).join("\n\n");
      await state.queue([reply]);
      await state.native(`/session/${session.id}/prompt_async`, "POST", {
        parts: [{
          type: "text",
          text: `Request ${n}: ` + "Explain the architecture. ".repeat(2),
        }],
      });
      await expect.poll(async () => {
        const rows = await state.native<
          { info: { role: string; time: { completed?: number } } }[]
        >(`/session/${session.id}/message`);
        return rows.filter((r) =>
          r.info.role === "assistant" && r.info.time.completed
        ).length;
      }).toBe(n + 1);
    }
    await openSession(state, page, session.id);
    await page.evaluate(() => document.fonts.ready);
    const initial = await page.locator(".otk-messages").evaluate((
      pane: HTMLElement,
    ) => ({
      top: pane.scrollTop,
      height: pane.clientHeight,
      total: pane.scrollHeight,
      scrollbar: getComputedStyle(pane).scrollbarWidth,
      hidden: pane.classList.contains("otk-scrollbar-hidden"),
    }));
    await page.locator(".otk-messages").evaluate((pane: HTMLElement) => {
      const g = globalThis as ProbeGlobal;
      g.invF = { frames: [], writes: [], events: [], step: -1, active: true };
      const d = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollTop",
      )!;
      Object.defineProperty(pane, "scrollTop", {
        get() {
          return d.get!.call(this);
        },
        set(value) {
          const before = d.get!.call(this);
          d.set!.call(this, value);
          g.invF.writes.push({
            at: performance.now(),
            step: g.invF.step,
            before,
            wanted: value,
            after: d.get!.call(this),
            total: pane.scrollHeight,
            stack: new Error().stack,
          });
        },
        configurable: true,
      });
      for (const type of ["wheel", "scroll", "scrollend"]) {
        pane.addEventListener(type, (e) => {
          g.invF.events.push({
            type,
            at: performance.now(),
            step: g.invF.step,
            top: pane.scrollTop,
            total: pane.scrollHeight,
            delta: e instanceof WheelEvent ? e.deltaY : undefined,
            trusted: e.isTrusted,
          });
        }, { capture: true, passive: true });
      }
      const ids = new WeakMap<Element, number>();
      let nextID = 0;
      function frame() {
        if (!g.invF.active) return;
        const root = pane.getBoundingClientRect();
        const rows = Array.from(pane.querySelectorAll("p,li,h1,h2,h3,pre"))
          .map((e) => {
            const r = e.getBoundingClientRect();
            if (r.bottom <= root.top || r.top >= root.bottom || !r.height) {
              return null;
            }
            if (!ids.has(e)) ids.set(e, ++nextID);
            return {
              id: ids.get(e)!,
              top: r.top - root.top,
              height: r.height,
              key: e.closest("[data-virtual-key]")?.getAttribute(
                "data-virtual-key",
              ),
              message: e.closest("[data-message]")?.getAttribute(
                "data-message",
              ),
              text: e.textContent?.slice(0, 70),
            };
          }).filter((row) => row !== null);
        g.invF.frames.push({
          at: performance.now(),
          step: g.invF.step,
          top: pane.scrollTop,
          total: pane.scrollHeight,
          height: pane.clientHeight,
          count: pane.querySelector(".otk-message-flow")?.getAttribute(
            "data-message-count",
          ),
          rows,
        });
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    const box = await page.locator(".otk-messages").boundingBox();
    await page.mouse.move(box!.x + 8, box!.y + box!.height / 2);
    for (let step = 0; step < Number(process.env.INV_F_STEPS ?? 650); step++) {
      await page.evaluate((step) => {
        (globalThis as ProbeGlobal).invF.step = step;
      }, step);
      await page.mouse.wheel(0, -Number(process.env.INV_F_DELTA ?? 48));
      await page.waitForTimeout(75);
    }
    await page.waitForTimeout(500);
    const evidence = await page.evaluate(() => {
      const e = (globalThis as ProbeGlobal).invF;
      e.active = false;
      return e;
    });
    const jumps: unknown[] = [];
    for (let i = 1; i < evidence.frames.length; i++) {
      const a = evidence.frames[i - 1], b = evidence.frames[i];
      const ordinal = (frame: SourceFrame) => {
        const row = frame.rows.find((r) =>
          /^Paragraph \d+-\d+:/.test(r.text ?? "")
        );
        const match = row?.text?.match(/^Paragraph (\d+)-(\d+):/);
        return match ? Number(match[1]) * 65 + Number(match[2]) : undefined;
      };
      const ao = ordinal(a), bo = ordinal(b);
      if (ao !== undefined && bo !== undefined && Math.abs(bo - ao) > 8) {
        jumps.push({ kind: "source-skip", before: a, after: b });
      }
      for (const row of b.rows) {
        const old = a.rows.find((r) =>
          r.id === row.id || r.message === row.message && r.text === row.text
        );
        if (old && Math.abs(row.top - old.top) > b.height) {
          jumps.push({ before: a, after: b, row, old });
        }
      }
    }
    await info.attach("inv-f-geometry", {
      body: JSON.stringify({ initial, jumps, ...evidence }),
      contentType: "application/json",
    });
    await info.attach("inv-f-owner", {
      body: diagnostics.join("\n"),
      contentType: "text/plain",
    });
    console.log(JSON.stringify({
      initial,
      frames: evidence.frames.length,
      writes: evidence.writes.length,
      jumps: jumps.length,
      maxWrite: Math.max(
        ...evidence.writes.map((w) => Math.abs(w.after - w.before)),
      ),
      final: evidence.frames.at(-1),
    }));
    expect(
      jumps,
      "Slow input never displaces a retained visible source by a screen",
    ).toEqual([]);
  },
);
