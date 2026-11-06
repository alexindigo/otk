// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";
import type { Page } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";

interface RangeSample {
  at: number;
  first: string;
  last: string;
  before: number;
  after: number;
  count: number;
  older: boolean;
  visible: number;
}
interface Measurements {
  ranges: RangeSample[];
  misses: unknown[];
  frames: { at: number; ms: number; historicalReads: number }[];
  historicalReads: number;
  longTasks: { at: number; ms: number }[];
}
const rank = (id: string) => Number(id.slice("msg_scale".length));
async function open(state: TestState, page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(state.url);
  await expect(page.locator(".heap-preview .otk-token").first()).toBeAttached({
    timeout: 60_000,
  });
  await page.locator("#heap-open-a").click();
  await expect.poll(() =>
    page.locator("#heap-state").getAttribute("data-a-count")
  ).toMatch(/^(?:[2-9]\d|\d{3,})$/);
  await page.evaluate("document.fonts.ready");
}
test.describe("scroll", () => {
  test.use({ profile: "contract-scale-scroll" });
  test(
    "scale.native-input-cadence-reserve",
    { tag: ["@scale"] },
    async ({ isolatedState: state, page }, info) => {
      test.setTimeout(600_000);
      await open(state, page);
      const population = await state.observe<
        { counts: unknown; expectedCounts: unknown }
      >();
      expect(population.counts).toEqual(population.expectedCounts);
      await page.locator("#heap-arm-reserve").click();
      await expect.poll(() =>
        page.evaluate<number>("scaleMeasurements.ranges.length")
      ).toBeGreaterThan(0);
      const current = () =>
        page.evaluate<RangeSample>("scaleMeasurements.ranges.at(-1)");
      const steps: unknown[] = [];
      const gesture = async (direction: -1 | 1, keyboard: boolean) => {
        const before = await current();
        const pane = page.locator(".heap-view .otk-messages");
        if (keyboard) {
          await pane.evaluate((pane) => {
            const v = pane.getBoundingClientRect();
            const target = Array.from(
              pane.querySelectorAll<HTMLElement>(".otk-created-trigger"),
            ).find((e) => {
              const r = e.getBoundingClientRect();
              return r.top >= v.top && r.bottom <= v.bottom;
            });
            target?.focus({ preventScroll: true });
          });
          await page.keyboard.press(direction < 0 ? "PageUp" : "PageDown");
        } else {
          const r = await pane.boundingBox();
          expect(r).toBeTruthy();
          await page.mouse.move(r!.x + r!.width / 2, r!.y + r!.height / 2);
          await page.mouse.wheel(0, direction * r!.height * .5);
        }
        // This is the measured input cadence, not a readiness delay. Sample even
        // if the reserve has not refilled, preserving the original workload.
        await page.evaluate(() =>
          new Promise((resolve) => setTimeout(resolve, 200))
        );
        const after = await current();
        const geometry = await pane.evaluate((pane) => {
          const v = pane.getBoundingClientRect();
          return {
            offscreen: Array.from(
              pane.querySelectorAll<HTMLElement>(
                '[aria-label="Transcript messages"] > .otk-virtual-item',
              ),
            ).filter((e) => {
              const r = e.getBoundingClientRect();
              return r.bottom <= v.top || r.top >= v.bottom;
            }).map((e) => ({
              key: e.dataset.virtualKey,
              focused: e.contains(document.activeElement),
              messages: Array.from(
                e.querySelectorAll<HTMLElement>("[data-message]"),
              )
                .map((m) => m.dataset.message),
            })),
            text: Array.from(pane.querySelectorAll(".otk-text p")).filter(
              (e) => {
                const r = e.getBoundingClientRect();
                return r.bottom > v.top && r.top < v.bottom;
              },
            ).map((e) => e.textContent),
          };
        });
        const pins = await page.evaluate("[...scaleMeasurements.pins]");
        steps.push({ direction, keyboard, before, after, geometry, pins });
        expect(geometry.text.length).toBeGreaterThan(0);
        expect(
          geometry.text.every((text) =>
            /^Scale fixture 0\/\d+\/\d+$/.test(text ?? "")
          ),
        ).toBe(true);
        return after;
      };
      try {
        let previous = await current(), stalled = 0;
        for (let n = 0; rank(previous.first) !== 0; n++) {
          expect(n).toBeLessThan(1000);
          const next = await gesture(-1, n % 3 === 2);
          stalled = next.first === previous.first ? stalled + 1 : 0;
          expect(stalled).toBeLessThan(15);
          previous = next;
        }
        const { reads } = await state.observe<
          { reads: { before: boolean }[] }
        >();
        expect(reads).toHaveLength(153);
        expect(reads.filter((r) => !r.before)).toHaveLength(1);
        const loaded = reads.length;
        stalled = 0;
        for (let n = 0; rank(previous.last) !== 1524; n++) {
          expect(n).toBeLessThan(1000);
          const next = await gesture(1, n % 3 === 2);
          stalled = next.last === previous.last ? stalled + 1 : 0;
          expect(stalled).toBeLessThan(15);
          previous = next;
        }
        await page.locator("#heap-stop-probe").click();
        await expect.poll(() =>
          page.evaluate(
            `(()=>{const pane=document.querySelector('.heap-view .otk-messages'),v=pane.getBoundingClientRect();return [...pane.querySelectorAll('[aria-label="Transcript messages"] > .otk-virtual-item')].every(e=>{const r=e.getBoundingClientRect();return (r.bottom>v.top&&r.top<v.bottom)||e.contains(document.activeElement)})})()`,
          )
        ).toBe(true);
        const result = await page.evaluate<Measurements>("scaleMeasurements");
        expect(result.ranges.length).toBeGreaterThan(100);
        expect((await state.observe<{ reads: unknown[] }>()).reads)
          .toHaveLength(loaded);
        await state.controller.call("scenario", {
          lease: state.lease.lease,
          action: "stop",
        });
        await info.attach("population-control-measurements", {
          body: JSON.stringify({
            population,
            steps,
            result,
            server: await state.observe(),
          }),
          contentType: "application/json",
        });
      } finally {
        await info.attach("input-schedule", {
          body: JSON.stringify(steps),
          contentType: "application/json",
        });
      }
    },
  );
});

test.describe("stream", () => {
  test.use({ profile: "contract-scale-runtime" });
  test(
    "scale.thousand-native-stream-updates",
    { tag: ["@scale"] },
    async ({ isolatedState: state, page, context }, info) => {
      test.setTimeout(300_000);
      await open(state, page);
      const population = await state.observe<
        {
          a: { id: string; nativeID: string };
          counts: unknown;
          expectedCounts: unknown;
        }
      >();
      expect(population.counts).toEqual(population.expectedCounts);
      await page.locator("#heap-load-all").click();
      await expect(page.locator("#heap-state")).toHaveAttribute(
        "data-a-count",
        "1525",
        { timeout: 120_000 },
      );
      await expect(page.locator("#heap-state")).toHaveAttribute(
        "data-loading",
        "false",
      );
      const pane = page.locator(".heap-view .otk-messages"),
        box = await pane.boundingBox();
      expect(box).toBeTruthy();
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.wheel(0, -300);
      // Join the real scroll completion before retaining the identity/anchor sample.
      await expect.poll(() =>
        pane.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop)
      ).toBeGreaterThan(100);
      await page.evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      await page.evaluate(
        `(()=>{const pane=document.querySelector('.heap-view .otk-messages'),v=pane.getBoundingClientRect();globalThis.stableHistoryNodes=[...pane.querySelectorAll('.otk-text')].filter(e=>{const r=e.getBoundingClientRect();return r.bottom>v.top&&r.top<v.bottom}).map(e=>({node:new WeakRef(e),top:e.getBoundingClientRect().top}));})()`,
      );
      expect(await page.evaluate<number>("stableHistoryNodes.length"))
        .toBeGreaterThan(0);
      const task = await state.product("tasks.create", {
        directory: state.directory,
        name: "Scale live actions",
        sessions: [population.a.id],
      });
      await state.product("tasks.rename", {
        id: task.id,
        name: "Scale live actions saved",
      });
      const chunks = Array.from(
          { length: 1000 },
          (_, n) => `live-${String(n).padStart(4, "0")}${n === 999 ? "" : " "}`,
        ),
        producer = await state.queue([...chunks, ""], "stepped");
      await page.locator("#heap-arm-stream").click();
      await state.native(
        `/session/${population.a.nativeID}/prompt_async`,
        "POST",
        {
          agent: "build",
          model: { providerID: "fake", modelID: "scripted" },
          parts: [{ type: "text", text: "Scale live transcript update" }],
        },
      );
      for (let n = 0; n < 1000; n++) {
        await state.release(producer.gate);
        await expect.poll(() =>
          page.evaluate<number>("scaleMeasurements.frames.length")
        ).toBe(n + 1);
      }
      await state.release(producer.gate);
      await expect.poll(() =>
        page.evaluate(
          "scaleMeasurements.frames.length===1000&&!!scaleMeasurements.completedMessage&&document.querySelector('#heap-state').dataset.aBusy==='false'",
        )
      ).toBe(true);
      await page.evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const stable = await page.evaluate<
        { connected: boolean; drift: number }[]
      >("stableHistoryNodes.map(value=>({connected:!!value.node.deref()?.isConnected,drift:Math.abs((value.node.deref()?.getBoundingClientRect().top??Infinity)-value.top)}))");
      expect(stable.every((n) => n.connected && n.drift <= 1)).toBe(true);
      await page.locator("#heap-stop-probe").click();
      const result = await page.evaluate<Measurements>("scaleMeasurements");
      expect(result.frames).toHaveLength(1000);
      expect(result.historicalReads).toBe(0);
      expect(result.frames.every((f) => f.historicalReads === 0)).toBe(true);
      expect(
        (await state.product("tasks.list", { directory: state.directory }))
          .find((t) => t.id === task.id)
          ?.name,
      ).toBe("Scale live actions saved");
      const native = await state.native<
          {
            info: { id: string; role: string };
            parts: { type: string; text?: string }[];
          }[]
        >(`/session/${population.a.nativeID}/message`),
        reply = native.filter((m) => m.info.role === "assistant").at(-1);
      expect(reply).toBeTruthy();
      const expected = chunks.join("");
      expect(
        reply!.parts.filter((p) => p.type === "text").map((p) => p.text).join(
          "",
        ),
      ).toBe(expected);
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.mouse.wheel(0, 1e7);
      const rendered = page.locator(`[data-message="${reply!.info.id}"]`);
      await expect(rendered).toContainText("live-0999", { timeout: 60_000 });
      const content = await rendered.locator(".otk-message-content")
        .boundingBox();
      expect(content).toBeTruthy();
      await page.mouse.move(
        content!.x + content!.width / 2,
        Math.min(content!.y + content!.height - 10, 720),
      );
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(state.url).origin,
      });
      await rendered.locator('[data-message-command="reply.copy"]').click();
      await expect.poll(() =>
        page.evaluate(() => navigator.clipboard.readText())
      ).toBe(expected);
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "stop",
      });
      await info.attach("population-control-measurements", {
        body: JSON.stringify({
          population,
          result,
          stable,
          server: await state.observe(),
        }),
        contentType: "application/json",
      });
    },
  );
});
