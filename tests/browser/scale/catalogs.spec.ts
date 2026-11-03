// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";
import { scaleGenerations, scaleWire } from "../fixtures/scale-wire.ts";

interface Watch {
  directory: string;
  acquired: number;
  subscriptions: number;
  releases: number;
  unsubscriptions: number;
  aborted: boolean;
  latePublications: number;
}
test.use({ profile: "contract-scale-files" });
test(
  "scale.complete-catalogs-keyed-tasks-provider",
  { tag: ["@scale"] },
  async ({ isolatedState: state, page }, info) => {
    test.setTimeout(600_000);
    const initial = await state.observe<
      {
        counts: unknown;
        expectedCounts: unknown;
        files: number;
        manifest: { sessions: { id: string }[] };
      }
    >();
    expect(initial.counts).toEqual(initial.expectedCounts);
    expect(initial.files).toBe(10000);
    const target = initial.manifest.sessions[0],
      frames = scaleWire(page),
      samples: unknown[] = [];
    await page.addInitScript(
      `globalThis.remainingDemand=[];globalThis.remainingSockets=[];(()=>{const Native=WebSocket;globalThis.WebSocket=class extends Native{constructor(...args){super(...args);remainingSockets.push(this)}};const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){const frame=JSON.parse(data);if(typeof frame.method==='string'&&/^(catalogs\\.|frecency\\.)/.test(frame.method))remainingDemand.push({method:frame.method,at:performance.now(),stack:new Error().stack});return send.call(this,data)}})()`,
    );
    const paintStart = performance.now();
    await page.goto(`${state.url}/#/local/${target.id}`);
    await expect(page.locator("textarea[name=prompt]")).toBeVisible();
    // The scale case owns the readiness lifetime. A browser-owned population
    // join observes the end consumer without racing a separate short poll
    // deadline against a single long rendering turn.
    const population = await page.locator(".otk-task-list").evaluate((list) =>
      new Promise<number>((resolve) => {
        const check = () => {
          const count = list.querySelectorAll("[data-tab]").length;
          if (count < 251) return;
          observer.disconnect();
          resolve(count);
        };
        const observer = new MutationObserver(check);
        observer.observe(list, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-tab"],
        });
        check();
      })
    );
    expect(population).toBeGreaterThanOrEqual(251);
    const paintMs = performance.now() - paintStart;
    const prompt = page.locator("textarea[name=prompt]"),
      autocomplete = page.locator(".otk-autocomplete");
    const fill = async (text: string) => {
      await prompt.click();
      await page.keyboard.press("Control+a");
      await page.keyboard.insertText(text);
    };
    await fill("@candidate-09999");
    type CatalogFrame = {
      t: string;
      kind?: string;
      last?: boolean;
      generation?: string;
      revision?: number;
      items?: { path?: string }[];
    };
    const publications = () =>
      frames.filter((event) =>
        event.direction === "received" && event.frame.t.startsWith("catalog.")
      ).map((event) => event.frame as CatalogFrame);
    const acquisitionStart = performance.now();
    while (
      !publications().some((frame) =>
        frame.t === "catalog.chunk" && frame.kind === "files" && frame.last
      )
    ) {
      const previous = publications().length;
      await expect.poll(() => publications().length, {
        timeout: 60_000,
        message: "Native catalog acquisition must keep completing publications",
      }).toBeGreaterThan(previous);
      samples.push({
        phase: "catalog-acquisition",
        publications: publications().length,
        ms: performance.now() - acquisitionStart,
      });
    }
    const terminal = publications().filter((frame) =>
      frame.kind === "files" && frame.last
    ).at(-1)!;
    const candidates = publications().filter((frame) =>
      frame.t === "catalog.chunk" && frame.kind === "files" &&
      frame.generation === terminal.generation &&
      frame.revision === terminal.revision
    ).flatMap((frame) => frame.items ?? []).map((item) => item.path ?? "")
      .filter((path) => /candidate-\d{5}\.txt$/.test(path));
    expect(candidates).toHaveLength(10000);
    expect(new Set(candidates).size).toBe(10000);
    await expect(autocomplete).toContainText("candidate-09999.txt", {
      timeout: 120_000,
    });
    const requests = () =>
      frames.filter((e) =>
        e.direction === "sent" && e.frame.t === "request" &&
        /^(catalogs\.|agents\.list|models\.list|commands\.list|resources\.list|find\.files|frecency\.list)/
          .test(e.frame.method)
      );
    const before = requests().length;
    const audit = async (closed = false) => {
      await expect.poll(() => {
        const accepted = scaleGenerations(frames).filter((g) => g.welcomes);
        return accepted.length > 0 &&
          accepted.every((g) =>
            g.requests.some((r) => r.method === "catalogs.watch") &&
            g.requests.some((r) => r.method === "frecency.list")
          );
      }).toBe(true);
      const generations = scaleGenerations(frames),
        accepted = generations.filter((g) => g.welcomes);
      await expect.poll(async () => {
        const { watches } = await state.observe<{ watches: Watch[] }>();
        return watches.length >= accepted.length &&
          (closed ? watches : watches.slice(0, -1)).every((w) =>
            w.releases === 1 && w.unsubscriptions === 1 && w.aborted
          );
      }).toBe(true);
      const { watches } = await state.observe<{ watches: Watch[] }>();
      for (const g of generations) {
        expect(g.hellos).toBe(1);
        expect(g.welcomes).toBe(g.requests.length ? 1 : 0);
        if (!g.welcomes) {
          expect(g.requests).toEqual([]);
          continue;
        }
        expect(g.requests.map((r) => r.method).sort()).toEqual([
          "catalogs.watch",
          "frecency.list",
        ]);
        expect(g.requests.every((r) => r.directory === state.directory)).toBe(
          true,
        );
      }
      expect(watches.length).toBeGreaterThanOrEqual(accepted.length);
      for (const w of watches) {
        expect(w.directory).toBe(state.directory);
        expect(w.acquired).toBe(1);
        expect(w.subscriptions).toBe(1);
        expect(w.latePublications).toBe(0);
      }
      for (const w of closed ? watches : watches.slice(0, -1)) {
        expect(w.releases).toBe(1);
        expect(w.unsubscriptions).toBe(1);
        expect(w.aborted).toBe(true);
      }
      if (!closed) {
        expect(watches.at(-1)?.releases).toBe(0);
        expect(watches.at(-1)?.unsubscriptions).toBe(0);
        expect(watches.at(-1)?.aborted).toBe(false);
      }
      samples.push({ closed, generations, watches });
      return accepted;
    };
    await audit();
    for (let n = 0; n < 100; n++) {
      await fill(
        `@candidate-${String(n).padStart(5, "0")}`,
      );
    }
    await fill("");
    await expect(autocomplete).toHaveCount(0);
    await prompt.click();
    for (let n = 0; n < 100; n++) await page.keyboard.press("Tab");
    let generations = await audit();
    if (generations.length === 1) {
      await page.evaluate(
        "remainingSockets.filter(socket=>socket.readyState===WebSocket.OPEN).forEach(socket=>socket.close())",
      );
      await expect.poll(() =>
        scaleGenerations(frames).filter((g) => g.welcomes).length
      ).toBeGreaterThanOrEqual(2);
      await expect(page.locator(".otk-connection-light")).toHaveAttribute(
        "data-connection-state",
        "connected",
      );
      generations = await audit();
    }
    expect(generations.length).toBeGreaterThanOrEqual(2);
    await state.product("tasks.rename", {
      id: "scale-task-0",
      name: "Current scale task",
    });
    await expect(page.locator("[data-tab=scale-task-0]")).toContainText(
      "Current scale task",
    );
    await state.controller.call("writeProjectFiles", {
      lease: state.lease.lease,
      files: { "catalog/group-99/new-after-watch.txt": "Watch update" },
    });
    await fill("@new-after-watch");
    await expect(autocomplete).toContainText("new-after-watch.txt");
    await audit();
    await fill("@candidate-09999");
    await expect(autocomplete).toContainText("candidate-09999.txt");
    await page.keyboard.press("Enter");
    await expect(page.locator(".otk-prompt-chip")).toContainText(
      "candidate-09999.txt",
    );
    await state.queue(["The last complete catalog candidate arrived."]);
    await page.locator('.otk-prompt button[type="submit"]').click();
    await expect(
      page.locator(".otk-text").filter({
        hasText: "The last complete catalog candidate arrived.",
      }),
    ).toHaveText("The last complete catalog candidate arrived.", {
      timeout: 120_000,
    });
    await expect.poll(async () => {
      const data = await state.observe<
        { entries: { id: string; status: string }[]; requests: unknown[] }
      >();
      return data.entries.find((e) => e.id === target.id)?.status === "idle" &&
        data.requests.some((r) =>
          JSON.stringify(r).includes("Private candidate 9999 contents")
        );
    }).toBe(true);
    const original = await state.observe<
        { frames: { t: string; entries?: unknown[] }[] }
      >(),
      baselineCount =
        original.frames.filter((f) => f.t === "index.snapshot").length;
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "hold",
    });
    await expect.poll(async () => {
      const { frames } = await state.observe<
        { frames: { t: string; entries?: unknown[] }[] }
      >();
      const snapshots = frames.filter((f) => f.t === "index.snapshot");
      return snapshots.length > baselineCount &&
        snapshots.at(-1)?.entries?.length === 4615;
    }).toBe(true);
    const final = await state.observe<{ frames: { t: string }[] }>();
    expect(final.frames.filter((f) => f.t === "inbox.snapshot")).toHaveLength(
      1,
    );
    const renderedTasks = await page.locator(".otk-task-list [data-tab]")
      .count();
    await page.close();
    await audit(true);
    await info.attach("population-control-measurements", {
      body: JSON.stringify({
        counts: initial.counts,
        tasks: 251,
        files: 10000,
        paintMs,
        localEdits: 100,
        localCycles: 100,
        additionalCatalogRequests: requests().length - before,
        samples,
        renderedTasks,
        completeCandidateAtProvider: true,
        initialInboxBaselines: 1,
        server: await state.observe(),
      }),
      contentType: "application/json",
    });
  },
);
