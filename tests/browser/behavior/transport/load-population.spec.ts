// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../fixtures/evidence.ts";
import { Controller } from "../../fixtures/protocol.ts";
import { finishState, TestState } from "../../fixtures/test-state.ts";
import { expect } from "../../fixtures/evidence.ts";
import type { TestLease } from "../../../support/fixture-control.ts";
import type { ServerFrame } from "@otk/protocol";

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
  ref?: { key: string };
  outcome?: { ok: boolean; result?: unknown };
  method?: string;
  params?: {
    sessionID?: string;
    directory?: string;
    sessions?: string[];
    sessionIDs?: string[];
    terminal?: number;
    runID?: string;
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
    acknowledgements: number;
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
        const seen: {
          key: string;
          sessionID: string;
          terminal: number;
          runID?: string;
        }[] = [];
        const finishes: number[] = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        page.on(
          "request",
          (r) =>
            http.push({
              at: Date.now(),
              value: `${r.method()} ${new URL(r.url()).pathname}`,
            }),
        );
        // Passive capture keeps the socket's own frame order: holding a subset
        // of frames would reorder inbox epochs against RPC results.
        page.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => {
            const frame = JSON.parse(payload.toString()) as IndexFrame;
            if (frame.t !== "request") return;
            rpc.push({ at: Date.now(), value: frame.method! });
            if (frame.method === "sessions.seen") {
              seen.push({
                key: frame.ref!.key,
                sessionID: frame.params!.sessionID!,
                terminal: frame.params!.terminal!,
                runID: frame.params!.runID,
              });
            }
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
          socket.on("framereceived", ({ payload }) => {
            const frame = JSON.parse(payload.toString()) as ServerFrame;
            const terminal = frame.t === "inbox.snapshot"
              ? frame.inbox.finishes[initial.selected]
              : frame.t === "inbox.patch"
              ? Math.max(
                0,
                ...frame.ops.flatMap((op) =>
                  op.op === "finish" && op.sessionID === initial.selected
                    ? [op.time]
                    : []
                ),
              )
              : 0;
            if (terminal && !finishes.includes(terminal)) {
              finishes.push(terminal);
            }
            incoming.push({
              at: Date.now(),
              frame: frame as IndexFrame,
              bytes: Buffer.byteLength(payload),
            });
          });
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
            // Issue 2.131 makes unknown assets 404. Use the real shell to
            // exercise the same HTTP ingress without relying on that fallback.
            const response = await context.request.get(`${state.url}/`);
            expect(response.ok()).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        })();
        try {
          await page.goto(`${state.url}/#/local/${initial.selected}`);
          await expect(page.locator("textarea[name=prompt]")).toBeVisible();
          await expect(page.locator(".otk-messages [data-message]").first())
            .toBeVisible();
          await expect.poll(() => finishes.length).toBe(1);
          // A finish learned after opening is acknowledged while focused.
          await page.locator("textarea[name=prompt]").focus();
          await expect.poll(() => seen.some((s) => s.terminal === finishes[0]))
            .toBe(true);
          await page.waitForTimeout(Math.max(0, until - Date.now()));
        } finally {
          active = false;
          await requests;
        }
        const end = await state.observe<NativeObservation>();
        expect(finishes).toHaveLength(1);
        // Exactly one acknowledgement per cause: opening acknowledges what is
        // known then (0 before the finish arrives, else the finish itself); a
        // finish learned after opening is a second, distinct cause. The opening
        // one awaits its visit, so the two may reach the wire in either order;
        // storage keeps the maximum.
        const tokens = seen.map((s) => s.terminal).sort((a, b) => a - b);
        expect(seen.every((s) => s.sessionID === initial.selected)).toBe(true);
        expect([[finishes[0]], [0, finishes[0]]]).toContainEqual(tokens);
        const exact = seen.find((s) => s.terminal === finishes[0])!;
        await expect.poll(() =>
          incoming.find(({ frame }) =>
            frame.t === "request.result" && frame.ref?.key === exact.key
          )?.frame.outcome
        ).toMatchObject({ ok: true, result: exact.terminal });
        const acknowledged = await state.product("inbox.get", {});
        // D81 stores run acknowledgements separately from legacy timestamps.
        // Observe the same canonical state that drives the selected session.
        const entity = Object.values(acknowledged.inbox.entities ?? {}).find(
          (value) => value.kind === "session" && value.id === initial.selected,
        );
        expect(entity).toMatchObject({
          terminal: exact.terminal,
          counts: { unseen: 0 },
        });
        expect(entity?.runID).toBe(exact.runID);
        if (!exact.runID) {
          expect(acknowledged.inbox.seen[initial.selected]).toBe(
            exact.terminal,
          );
        }
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
        // Acknowledgements follow their observed causes above; every other
        // method must be identical across populations.
        const { "sessions.seen": acknowledgements, ...methods } = counts(
          window(rpc),
        );
        expect(acknowledgements).toBe(seen.length);
        const measured = {
          rpc: methods,
          http: counts(window(http)),
          native: counts(
            end.requests.filter((r) => r.at <= until).map((r) =>
              `${r.method} ${r.path}`
            ),
          ),
          catalogCeiling: initial.catalogBudget.ceiling,
          acknowledgements,
        };
        results.push(measured);
        measurements.push({
          size,
          ...initial,
          requests: undefined,
          seconds: 30,
          seen: { acknowledged: seen, published: finishes },
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
    // Each acknowledgement validates its session's identity. The V1 identity
    // owner (harness-opencode-v1 digest `identities`) gates that read on one
    // native liveness probe, so probes follow acknowledgement causes, not
    // population; all remaining probes stay exact.
    const health = "GET /global/health";
    const essential = (result: (typeof results)[number]) => {
      const native = Object.fromEntries(
        Object.entries(result.native).filter(([path]) => !catalog.has(path)),
      );
      if (native[health] !== undefined) {
        native[health] -= result.acknowledgements;
      }
      return native;
    };
    expect(essential(results[1])).toEqual(essential(results[0]));
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
