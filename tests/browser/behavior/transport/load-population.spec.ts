// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../fixtures/evidence.ts";
import { Controller } from "../../fixtures/protocol.ts";
import { finishState, TestState } from "../../fixtures/test-state.ts";
import { expect } from "../../fixtures/evidence.ts";
import type { TestLease } from "../../../support/fixture-control.ts";

interface NativeObservation {
  population: number;
  projects: number;
  selected: string;
  directory: string;
  count: number;
  unrelatedMessages: number;
  catalogBudget: { kinds: number; refreshes: number; ceiling: number };
  requests: {
    at: number;
    method: string;
    path: string;
    directory: string | null;
  }[];
}
interface IndexFrame {
  t: string;
  entries?: { id: string }[];
  ops?: { op: string; entry?: { id: string }; id?: string }[];
  inbox?: { summaries?: Record<string, unknown> };
  summaries?: { directory: string }[];
  method?: string;
  params?: {
    sessionID?: string;
    directory?: string;
    sessions?: string[];
    sessionIDs?: string[];
  };
}
function counts(values: string[]) {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
}
test("transport.load-requests-do-not-scale-with-unseen-population", {
  tag: ["@load", "@transport", "@sessions", "@messages"],
}, async ({ browser }, info) => {
  test.setTimeout(240000);
  const measurements: unknown[] = [];
  const results: {
    rpc: Record<string, number>;
    http: Record<string, number>;
    native: Record<string, number>;
    catalogCeiling: number;
  }[] = [];
  try {
    for (const size of ["small", "large"] as const) {
      const controller = await new Controller(
        `load-${size}`,
        info.project.metadata.nativeVersion ??
          info.project.name.replace(/^(?:oc|scale)-/, ""),
      ).start(`contract-load-${size}`);
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
      });
      const lease = await controller.call<TestLease>("beginTest", {
        identity: info.testId,
      });
      const state = new TestState(controller, lease, context);
      try {
        const initial = await state.observe<NativeObservation>();
        expect(initial.count).toBe(initial.population + 1);
        expect(initial.unrelatedMessages).toBe(initial.population * 2);
        const page = await context.newPage();
        const rpc: { at: number; value: string }[] = [],
          http: { at: number; value: string }[] = [],
          incoming: { at: number; frame: IndexFrame; bytes: number }[] = [];
        const sessionReads: { at: number; value: string }[] = [],
          directories: { at: number; value: string }[] = [],
          errors: string[] = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        page.on(
          "request",
          (r) =>
            http.push({
              at: Date.now(),
              value: `${r.method()} ${new URL(r.url()).pathname}`,
            }),
        );
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            const frame = JSON.parse(payload.toString()) as IndexFrame;
            if (frame.t !== "request") return;
            rpc.push({ at: Date.now(), value: frame.method! });
            const targets = [
              ...(frame.params?.sessionID ? [frame.params.sessionID] : []),
              ...(frame.params?.sessions ?? []),
              ...(frame.params?.sessionIDs ?? []),
            ];
            for (const id of targets) {
              sessionReads.push({
                at: Date.now(),
                value: id,
              });
            }
            if (frame.params?.directory) {
              directories.push({
                at: Date.now(),
                value: frame.params.directory,
              });
            }
          });
          socket.on(
            "framereceived",
            ({ payload }) =>
              incoming.push({
                at: Date.now(),
                frame: JSON.parse(payload.toString()),
                bytes: Buffer.byteLength(payload),
              }),
          );
        });
        const start = Date.now(), until = start + 30000;
        const window = (values: { at: number; value: string }[]) =>
          values.filter((row) => row.at >= start && row.at <= until).map((
            row,
          ) => row.value);
        // Rule 6 permits unrelated idle fill: exact demand budgets belong to an
        // active-request window, not the superseded connected-but-idle window.
        let active = true;
        const requests = (async () => {
          while (active) {
            const response = await context.request.get(
              `${state.url}/manifest.json`,
            );
            expect(response.ok()).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        })();
        try {
          await page.goto(`${state.url}/#/local/${initial.selected}`);
          await expect(page.locator("textarea[name=prompt]")).toBeVisible();
          await expect(page.locator(".otk-messages [data-message]").first())
            .toBeVisible();
          await page.waitForTimeout(Math.max(0, until - Date.now()));
        } finally {
          active = false;
          await requests;
        }
        const end = await state.observe<NativeObservation>();
        const received = incoming.filter((row) =>
          row.at >= start && row.at <= until
        );
        const index = received.filter(({ frame }) =>
          frame.t === "index.snapshot" || frame.t === "index.patch"
        );
        const entryIDs = index.flatMap(({ frame }) =>
          frame.entries?.map((e) => e.id) ?? frame.ops?.flatMap((op) =>
            op.op === "upsert"
              ? [op.entry!.id]
              : op.op === "digest"
              ? [op.id!]
              : []
          ) ?? []
        );
        expect([...new Set(entryIDs)]).toEqual([initial.selected]);
        const reads = window(sessionReads);
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.filter((id) => id !== initial.selected)).toEqual([]);
        expect(
          window(directories).every((directory) =>
            directory === initial.directory
          ),
        ).toBe(true);
        expect(errors).toEqual([]);
        const summaries = new Set(
          received.flatMap(({ frame }) =>
            frame.t === "inbox.snapshot"
              ? Object.keys(frame.inbox?.summaries ?? {})
              : frame.t === "inbox.summaries"
              ? frame.summaries!.map((s) => s.directory)
              : []
          ),
        );
        expect(summaries.size).toBe(initial.projects + 1);
        expect(
          end.requests.filter((r) => r.directory?.includes("/discovered/")),
        ).toEqual([]);
        for (const request of end.requests) {
          const session = request.path.match(/^\/session\/(ses_[^/]+)/)?.[1];
          if (session) {
            expect(
              `${initial.selected.split("-")[0]}-${
                decodeURIComponent(session)
              }`,
            ).toBe(
              initial.selected,
            );
          }
        }
        const measured = {
          rpc: counts(window(rpc)),
          http: counts(window(http)),
          native: counts(
            end.requests.filter((r) => r.at <= until).map((r) =>
              `${r.method} ${r.path}`
            ),
          ),
          catalogCeiling: initial.catalogBudget.ceiling,
        };
        results.push(measured);
        measurements.push({
          size,
          ...initial,
          requests: undefined,
          seconds: 30,
          ...measured,
          indexFrames: index.length,
          indexBytes: index.reduce((n, f) => n + f.bytes, 0),
          incomingSessionEntries: entryIDs.length,
          leasedSessionIDs: [...new Set(entryIDs)],
          projectSummaries: summaries.size,
          unrelatedRequests: 0,
          unrelatedPerSessionRequestsPerSecond: 0,
          selectedPerSessionRequestsPerSecond: reads.length / 30,
        });
      } finally {
        await finishState(state, info);
        await controller.stop();
      }
    }
    expect(results[1].rpc).toEqual(results[0].rpc);
    expect(results[1].http).toEqual(results[0].http);
    // Catalog refresh and native-I/O preemption order may redistribute attempts.
    // Both populations share the same owner-derived endpoint and aggregate caps.
    expect(results[1].catalogCeiling).toBe(results[0].catalogCeiling);
    const catalog = new Set(
      [
        "/agent",
        "/command",
        "/skill",
        "/config/providers",
        "/config",
        "/experimental/resource",
        "/question",
        "/file",
      ].map((path) => `GET ${path}`),
    );
    const essential = (value: Record<string, number>) =>
      Object.fromEntries(
        Object.entries(value).filter(([path]) => !catalog.has(path)),
      );
    expect(essential(results[1].native)).toEqual(essential(results[0].native));
    for (const result of results) {
      const catalogTotal = Object.entries(result.native)
        .filter(([endpoint]) => catalog.has(endpoint))
        .reduce((sum, [, count]) => sum + count, 0);
      expect(catalogTotal).toBeLessThanOrEqual(
        catalog.size * result.catalogCeiling,
      );
      for (const [endpoint, count] of Object.entries(result.native)) {
        expect(count, endpoint).toBeLessThanOrEqual(result.catalogCeiling);
      }
    }
  } finally {
    await info.attach("load-population-measurements", {
      body: JSON.stringify(measurements, null, 2),
      contentType: "application/json",
    });
  }
});
