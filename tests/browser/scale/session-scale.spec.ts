// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";
import { type ScaleFrame, scaleWire } from "../fixtures/scale-wire.ts";
import {
  assertReadDemand,
  requestReads,
} from "../fixtures/request-evidence.ts";
import { sendPrompt } from "../pages/composer.ts";
import { contextCommand } from "../pages/menus.ts";
import type { Page } from "@playwright/test";
import type { ServerFrame } from "@otk/protocol";

interface Session {
  id: string;
  nativeID: string;
  directory: string;
  title: string;
  expected: { cost: number };
}
interface Observation {
  manifest: { sessions: Session[] };
  counts: unknown;
  expectedCounts: unknown;
  ready: string[];
  readyCount: number;
  entries: { id: string; status: string; attention: { permissions: number } }[];
  entry: { status: string; attention: { permissions: number } } | null;
  taskMembers: string[];
  expectedCosts: Record<string, string>;
  requests: unknown[];
}
interface Call {
  t: string;
  method: string;
  ref?: { window: string };
  params?: { sessionID?: string; before?: string };
}
const viewport = ".otk-project-session-tree",
  search = '[aria-label="Search sessions by title"]';
const framesAhead =
  "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))";
async function light(page: Page, selector: string) {
  const node = page.locator(selector);
  await expect(node).toBeVisible();
  const r = await node.boundingBox();
  expect(r).toBeTruthy();
  const v = page.viewportSize()!;
  expect(r!.x).toBeGreaterThanOrEqual(0);
  expect(r!.y).toBeGreaterThanOrEqual(0);
  expect(r!.x + r!.width).toBeLessThanOrEqual(v.width);
  expect(r!.y + r!.height).toBeLessThanOrEqual(v.height);
}
function listParents(frames: ScaleFrame[]) {
  const witnesses = new Map<string, number>();
  const methods = new Map<string, string>();
  for (const event of frames) {
    if (event.direction === "sent" && event.frame.t === "request") {
      methods.set(event.frame.ref!.key, event.frame.method);
      continue;
    }
    if (event.direction !== "received") continue;
    const frame = event.frame as unknown as ServerFrame;
    // Warm lists may deliver a complete page only in their scalar result.
    const items = frame.t === "load.chunk" && frame.data.kind === "session-list"
      ? frame.data.items
      : frame.t === "request.result" && frame.outcome.ok &&
          methods.get(frame.ref.key) === "sessions.list"
      ? (frame.outcome.result as { items: { parentID?: string }[] }).items
      : [];
    for (const item of items) {
      if (item.parentID) {
        witnesses.set(item.parentID, (witnesses.get(item.parentID) ?? 0) + 1);
      }
    }
  }
  return witnesses;
}
function listExhausted(frames: ScaleFrame[], directory: string) {
  let key: string | undefined, exhausted = false;
  for (const event of frames) {
    const raw = event.frame;
    if (event.direction === "sent" && raw.t === "hello") {
      key = undefined;
      exhausted = false;
    }
    if (
      event.direction === "sent" && raw.t === "request" &&
      raw.method === "sessions.list" && raw.params?.directory === directory &&
      !raw.params.query
    ) {
      key = raw.ref!.key;
      exhausted = false;
    }
    if (event.direction !== "received") continue;
    const frame = raw as unknown as ServerFrame;
    if (
      frame.t === "load.chunk" && frame.request.key === key &&
      frame.data.kind === "session-list" && frame.load.state === "complete"
    ) {
      exhausted = frame.data.older === null;
    }
    if (
      frame.t === "request.result" && frame.ref.key === key && frame.outcome.ok
    ) {
      exhausted =
        (frame.outcome.result as { older: string | null }).older === null;
    }
  }
  return exhausted;
}
function scoped(
  calls: Call[],
  selected: string,
  members: Set<string>,
  attention = new Set<string>(),
  parentWitnesses = new Map<string, number>(),
) {
  const reads = new Map<string, unknown[]>();
  const parentReads = new Map<string, number>();
  for (const frame of calls) {
    const params = frame.params, id = params?.sessionID;
    if (!id || id === selected) continue;
    if (frame.method === "permission.list" && attention.has(id)) continue;
    // A demanded Sessions page acquires missing ancestor metadata, never bodies.
    // Bound those exact scalar reads by parent witnesses actually delivered to
    // this socket, rather than allowing arbitrary population metadata reads.
    if (frame.method === "session.get") {
      expect(Object.keys(params!).sort()).toEqual(["sessionID"]);
      const count = (parentReads.get(id) ?? 0) + 1;
      parentReads.set(id, count);
      expect(count, id).toBeLessThanOrEqual(parentWitnesses.get(id) ?? 0);
      continue;
    }
    expect(frame.method).toBe("session.messages");
    expect(members.has(id), id).toBe(true);
    expect(Object.keys(params!).sort()).toEqual(
      params?.before ? ["before", "sessionID"] : ["sessionID"],
    );
    const cursors = reads.get(id) ?? [];
    cursors.push(params?.before);
    reads.set(id, cursors);
  }
  for (const cursors of reads.values()) {
    expect(cursors.length).toBeLessThanOrEqual(2);
    expect(cursors[0]).toBeUndefined();
    if (cursors.length === 2) expect(cursors[1]).toEqual(expect.any(String));
  }
}
test.use({ profile: "contract-scale-sessions" });
test("scale.session-list-context-is-metadata-only-and-demand-bounded", {
  tag: ["@scale"],
}, () => {
  const context = {
    t: "request",
    method: "session.get",
    params: { sessionID: "parent" },
  };
  const witnessed = new Map([["parent", 1]]);
  scoped([context], "selected", new Set(), new Set(), witnessed);
  expect(() => scoped([context], "selected", new Set())).toThrow();
  expect(() =>
    scoped([context, context], "selected", new Set(), new Set(), witnessed)
  ).toThrow();
  expect(() =>
    scoped(
      [{ ...context, params: { ...context.params, before: "body" } }],
      "selected",
      new Set(),
      new Set(),
      witnessed,
    )
  ).toThrow();
  expect(() =>
    scoped(
      [{ ...context, method: "session.messages" }],
      "selected",
      new Set(),
      new Set(),
      witnessed,
    )
  ).toThrow();
});
test(
  "scale.cold-warm-windows-interactive-supervision",
  { tag: ["@scale"] },
  async ({ isolatedState: state, page }, info) => {
    test.setTimeout(900_000);
    const initial = await state.observe<Observation>();
    expect(initial.counts).toEqual(initial.expectedCounts);
    const sessions = initial.manifest.sessions,
      selected = sessions[0],
      background = sessions[251].directory,
      // Sessions retains creation order. Use its last editable row, not the
      // native activity page's old tail at 2 or archived fixture row 250.
      last = sessions[249];
    await state.product("layout.patch", {
      rightCollapsed: false,
      rightView: "sessions",
    });
    const grouped = await state.product("tasks.create", {
      directory: state.directory,
      name: "Scale grouped work",
      sessions: [selected.id, sessions[4].id],
    });
    const frames = scaleWire(page),
      runs: unknown[] = [],
      observations: Record<string, unknown> = {};
    // Sessions supplies ListRow's session-title slot; the legacy Sidebar title
    // is not part of this consumer's paint, rename or geometry contract.
    await page.addInitScript(`(()=>{
    const Native=WebSocket,titles=new Set(${
      JSON.stringify([
        ...sessions.slice(0, 251).map((s) => s.title),
        "Scale interactive outcome",
      ])
    });globalThis.scale={snapshots:[],calls:[],cancels:[],results:[],paints:[]};
    globalThis.WebSocket=class extends Native{
      constructor(...args){super(...args);this.addEventListener('message',event=>{const f=JSON.parse(event.data),at=performance.now();if(f.t==='request.result')scale.results.push({at,wall:Date.now(),...f,id:f.ref.key,ok:f.outcome.ok});const entries=f.t==='index.snapshot'?f.entries:f.t==='index.patch'?f.ops.filter(op=>op.op==='upsert').map(op=>op.entry):[];if(!entries.some(e=>e.id==='${selected.id}')||!location.hash.endsWith('/${selected.id}'))return;
      const scoped=entries.filter(e=>e.directory===${
      JSON.stringify(selected.directory)
    }),snapshot={at,ready:scoped.every(e=>e.digest.state==='ready'),count:entries.length,ids:entries.map(e=>e.id),unready:scoped.filter(e=>e.digest.state!=='ready').slice(0,20).map(e=>({id:e.id,state:e.digest.state,revision:e.digest.revision}))};scale.snapshots.push(snapshot);
      const paint=()=>{const rows=[...document.querySelectorAll('.otk-session-row')],v=document.querySelector('${viewport}'),chosen=document.querySelector('[data-session="${selected.id}"]'),boxes=rows.map(r=>r.getBoundingClientRect()),bound=v?Math.ceil(v.clientHeight/Math.min(...boxes.map(r=>r.height)))+12:0;const valid=rows.length>0&&rows.length<=bound&&v&&chosen?.getAttribute('aria-current')==='page'&&rows.every((row,i)=>boxes[i].width>0&&boxes[i].height>0&&row.querySelector('.otk-status-light')&&titles.has(row.querySelector('.otk-session-title')?.textContent));if(valid)scale.paints.push({snapshot,at:performance.now(),elapsed:performance.now()-at,rows:rows.length,bound});else requestAnimationFrame(paint)};requestAnimationFrame(paint);});}
      send(data){const f=JSON.parse(data);if(f.t==='request')scale.calls.push({at:performance.now(),wall:Date.now(),...f,id:f.ref.key});if(f.t==='request.release')scale.cancels.push(...f.refs.map(ref=>({at:performance.now(),id:ref.key,ref})));super.send(data);}
    };
  })()`);
    const status = (id: string, value: string) =>
      expect.poll(async () =>
        (await state.observe<Pick<Observation, "entry">>({ entry: id })).entry
          ?.status
      ).toBe(value);
    const calls = () =>
      frames.filter((e) => e.direction === "sent" && e.frame.t === "request")
        .map((e) => e.frame as unknown as Call);
    const windowBound = async (pins = 0) => {
      const result = await page.locator(viewport).evaluate((v, pins) => {
        const rows = Array.from(v.querySelectorAll(".otk-session-row")),
          height = Math.min(
            ...rows.map((r) => r.getBoundingClientRect().height),
          );
        return {
          count: rows.length,
          bound: Math.ceil(v.clientHeight / height) + 12 + pins,
        };
      }, pins);
      expect(result.count).toBeGreaterThan(0);
      expect(result.count).toBeLessThanOrEqual(result.bound);
      return result;
    };
    const wheel = async (delta: number) => {
      const started = performance.now(), samples: unknown[] = [];
      observations.transitions ??= [];
      (observations.transitions as unknown[]).push({ delta, samples });
      const r = await page.locator(viewport).boundingBox();
      expect(r).toBeTruthy();
      await page.mouse.move(r!.x + r!.width / 2, r!.y + r!.height / 2);
      const overlap = await page.locator(".otk-session-row").first().evaluate(
        (row) => row.getBoundingClientRect().height,
      );
      // Page through measured windows with one row of overlap. The deadline
      // bounds this whole transition, not an unnecessary half-page input cadence.
      let direction = delta;
      const scroll = async () => {
        const moves = await page.locator(viewport).evaluate((el, direction) => {
          const end = el.scrollHeight - el.clientHeight;
          const moves = direction > 0
            ? el.scrollTop < end - .5
            : el.scrollTop > .5;
          if (moves) {
            el.setAttribute("data-scale-scroll", "pending");
            el.addEventListener(
              "scrollend",
              () => el.setAttribute("data-scale-scroll", "settled"),
              { once: true },
            );
          }
          return moves;
        }, direction);
        await page.mouse.wheel(
          0,
          direction > 0 ? Math.min(direction, r!.height - overlap) : direction,
        );
        // wheel() acknowledges dispatch, not native scrolling or windowing.
        if (moves) {
          await expect(page.locator(viewport)).toHaveAttribute(
            "data-scale-scroll",
            "settled",
          );
        }
        await page.evaluate(framesAhead);
        samples.push({
          elapsed: performance.now() - started,
          ...(await page.locator(viewport).evaluate((el) => ({
            top: el.scrollTop,
            height: el.scrollHeight,
            viewport: el.clientHeight,
            rows: Array.from(el.querySelectorAll("[data-session]")).map((row) =>
              row.getAttribute("data-session")
            ),
          }))),
          exhausted: listExhausted(frames, selected.directory),
        });
      };
      // A paged list extends its end as demand is answered; one wheel is not full-population acquisition.
      await expect.poll(async () => {
        if (delta > 0) {
          const target = await page.locator(viewport).evaluate((el, id) => {
            const row = el.querySelector(`[data-session="${id}"]`);
            if (!row) return null;
            const r = row.getBoundingClientRect(),
              v = el.getBoundingClientRect();
            const top = v.top + el.clientTop, bottom = top + el.clientHeight;
            return {
              visible: r.height > 0 && r.top >= top - .5 &&
                r.bottom <= bottom + .5,
              delta: (r.top + r.bottom - top - bottom) / 2,
            };
          }, last.id);
          if (listExhausted(frames, selected.directory) && target) {
            if (target.visible) return true;
            direction = target.delta;
          }
          // Held discovery order can put the target before the source's final
          // page. Once exhausted, scan back through overlapping native windows
          // rather than wheeling forever against the physical bottom.
          if (
            direction > 0 && listExhausted(frames, selected.directory) &&
            await page.locator(viewport).evaluate((el) =>
              el.scrollTop >= el.scrollHeight - el.clientHeight - .5
            )
          ) {
            direction = -(r!.height - overlap);
          }
        } else if (
          await page.locator(viewport).evaluate((e) => e.scrollTop < 1)
        ) {
          return true;
        }
        await scroll();
        return false;
      }, { intervals: [0, 16, 32] }).toBe(true);
    };
    const anchor = () =>
      page.locator(viewport).evaluate((v) => {
        const r = v.getBoundingClientRect(),
          e = Array.from(v.querySelectorAll<HTMLElement>("[data-virtual-key]"))
            .find((e) => e.getBoundingClientRect().bottom > r.top + .5)!;
        return {
          key: e.dataset.virtualKey,
          offset: e.getBoundingClientRect().top - r.top,
          scrollTop: v.scrollTop,
          scrollHeight: v.scrollHeight,
          clientHeight: v.clientHeight,
        };
      });
    let failure: { cause: unknown } | undefined;
    try {
      await page.goto(`${state.url}/#/local/${selected.id}`);
      await expect.poll(() => page.evaluate<number>("scale.paints.length"), {
        timeout: 120_000,
      }).toBeGreaterThan(0);
      const cold = await page.evaluate<
        {
          elapsed: number;
          bound: number;
          snapshot: { ready: boolean; count: number; ids: string[] };
        }
      >("scale.paints[0]");
      expect(cold.snapshot.ready).toBe(false);
      observations.cold = cold;
      const taskMembers = new Set(
        (await state.observe<Pick<Observation, "taskMembers">>({
          fields: ["taskMembers"],
        })).taskMembers,
      );
      expect(calls().filter((f) => f.method === "usage.get")).toEqual([]);
      scoped(calls(), selected.id, taskMembers, new Set(), listParents(frames));
      await expect.poll(
        async () =>
          (await state.observe<{ frames: { t: string; state?: string }[] }>({
            fields: ["frames"],
          })).frames.some((frame) =>
            frame.t === "harness" && frame.state === "connected"
          ),
        { timeout: 120_000 },
      ).toBe(true);
      await expect(page.locator("[data-connection=local]")).toHaveAttribute(
        "aria-label",
        /agent service connected/,
      );
      const actionsStart = performance.now();
      await page.locator(".otk-task-new").click();
      await page.locator("input[name=taskName]").fill("Scale pending task");
      await page.locator('dialog button[type="submit"]').click();
      await expect(page.locator("dialog")).toHaveCount(0);
      await expect(page.locator(".otk-project-tabs")).toContainText(
        "Scale pending task",
      );
      const actionTask =
        (await state.product("tasks.list", { directory: state.directory }))
          .find((t) => t.name === "Scale pending task");
      expect(actionTask).toBeTruthy();
      await page.locator(`[data-tab="${actionTask!.id}"]`).click({
        button: "right",
      });
      const menu = page.locator(
        ':popover-open [role="menu"][aria-label="Context menu"]',
      );
      await contextCommand(menu, "task.rename").click();
      await page.locator("input[name=taskName]").fill("Scale saved task");
      await page.locator('dialog button[type="submit"]').click();
      await expect(page.locator(".otk-project-tabs")).toContainText(
        "Scale saved task",
      );
      expect(
        (await state.product("tasks.list", { directory: state.directory }))
          .find((t) => t.id === actionTask!.id)?.name,
      ).toBe("Scale saved task");
      const live = await state.native<{ id: string }>("/session", "POST", {
          title: "Scale interactive outcome",
        }),
        liveID = `${selected.id.split("-")[0]}-${live.id}`;
      await page.locator(search).fill("Scale interactive outcome");
      await page.locator(`[data-session="${liveID}"]`).click();
      await expect(page.locator("textarea[name=prompt]")).toBeVisible();
      const held = await state.queue(["Scale accepted reply"], "held");
      await page.locator("textarea[name=prompt]").fill(
        "Scale interactive prompt",
      );
      await sendPrompt(page);
      await status(liveID, "busy");
      await expect(page.locator(".otk-messages")).toContainText(
        "Scale accepted reply",
      );
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await status(liveID, "idle");
      await state.release(held.gate);
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        chunks: [],
        tool: {
          name: "bash",
          input: {
            command: "printf scale_approved",
            description: "Scale approval",
          },
        },
      });
      await state.queue(["Scale approval confirmed"]);
      await page.locator("textarea[name=prompt]").fill(
        "Approval during scale backfill",
      );
      await sendPrompt(page);
      await page.locator(".otk-permission-actions > button").first().click();
      await expect(page.locator(".otk-messages")).toContainText(
        "Scale approval confirmed",
      );
      await expect(page.locator(".otk-permission-dock")).toHaveCount(0);
      await status(liveID, "idle");
      expect(
        await page.evaluate(
          "scale.results.filter(f=>f.ok===false&&!scale.cancels.some(c=>c.id===f.id&&c.at<=f.at))",
        ),
      ).toEqual([]);
      await expect(
        page.getByRole("alert").filter({
          hasText: /timed out|aborted due to timeout/i,
        }),
      ).toHaveCount(0);
      observations.interactiveMs = performance.now() - actionsStart;
      const createBackground = async (title: string) => {
        const s = await state.controller.call<{ id: string }>("nativeRequest", {
          lease: state.lease.lease,
          path: "/session",
          method: "POST",
          project: "secondary",
          body: { title },
        });
        return { native: s.id, id: `${selected.id.split("-")[0]}-${s.id}` };
      };
      const begin = (s: { native: string }, text: string) =>
        state.controller.call("nativeRequest", {
          lease: state.lease.lease,
          path: `/session/${s.native}/prompt_async`,
          method: "POST",
          project: "secondary",
          body: {
            model: { providerID: "fake", modelID: "scripted" },
            parts: [{ type: "text", text }],
          },
        });
      const providerRequests = (text: string) =>
        expect.poll(async () =>
          (await state.observe<Pick<Observation, "requests">>({
            fields: ["requests"],
          })).requests.filter((r) => {
            const body = JSON.stringify(r);
            return body.includes(text) &&
              !body.includes("Generate a title for this conversation:");
          }).length
        ).toBeGreaterThan(0);
      const backgroundStart = frames.length;
      const finished = await createBackground("Background finished"),
        firstHold = await state.queue(["Background working"], "held");
      await page.locator(search).fill("No matching scale title");
      await begin(finished, "Background first work");
      await status(finished.id, "busy");
      await providerRequests("Background first work");
      const project = `[data-project=${JSON.stringify(background)}]`;
      await light(page, `${project} .otk-status-light[data-state=working]`);
      await state.product("session.abort", { sessionID: finished.id });
      await status(finished.id, "idle");
      await state.release(firstHold.gate);
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        chunks: [],
        tool: {
          name: "bash",
          input: {
            command: "printf scale_background",
            description: "Background permission",
          },
        },
      });
      const finishHold = await state.queue(["Background completed"], "held");
      await begin(finished, "Background needs input");
      await expect.poll(async () =>
        (await state.observe<Pick<Observation, "entry">>({
          entry: finished.id,
        })).entry?.attention.permissions ?? 0
      ).toBeGreaterThan(0);
      await light(page, `${project} .otk-status-light[data-state=blocked]`);
      const permissions = await state.product("permission.list", {
        sessionID: finished.id,
      });
      await state.product("permission.reply", {
        sessionID: finished.id,
        requestID: permissions[0].id,
        reply: "once",
      });
      await state.release(finishHold.gate);
      await status(finished.id, "idle");
      await light(page, `${project} .otk-status-light[data-state=finished]`);
      const working = await createBackground("Background working");
      await state.queue(["Still working"], "held");
      await begin(working, "Keep background work active");
      await status(working.id, "busy");
      await providerRequests("Keep background work active");
      const blocked = await createBackground("Background blocked");
      await state.controller.call("queueScript", {
        lease: state.lease.lease,
        chunks: [],
        tool: {
          name: "bash",
          input: {
            command: "printf scale_blocked",
            description: "Retained background permission",
          },
        },
      });
      await begin(blocked, "Keep background input visible");
      await expect.poll(async () =>
        (await state.observe<Pick<Observation, "entry">>({
          entry: blocked.id,
        })).entry?.attention.permissions ?? 0
      ).toBeGreaterThan(0);
      await state.product("layout.location", {
        sidecarId: "local",
        directory: background,
        sessionID: working.id,
      });
      await page.getByRole("button", { name: "Collapse projects", exact: true })
        .click();
      await page.locator(".otk-panel-collapse").click();
      await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
        "data-collapsed",
        "true",
      );
      await expect(page.locator(".otk-right-panel")).toBeHidden();
      await expect(page.locator(".otk-project-sessions")).toHaveCount(0);
      runs.push(await page.evaluate("scale"));
      const reloadStart = frames.length;
      await page.reload();
      // Navigation may still emit old-document requests before closing its
      // socket. The new hello, not the host's reload call, starts this phase.
      const newHello = () =>
        frames.findIndex((event, index) =>
          index >= reloadStart && event.direction === "sent" &&
          event.frame.t === "hello"
        );
      await expect.poll(newHello).toBeGreaterThanOrEqual(reloadStart);
      const backgroundEnd = newHello();
      await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
        "data-collapsed",
        "true",
      );
      await expect(page.locator(".otk-right-panel")).toBeHidden();
      await expect(page.locator(".otk-project-sessions")).toHaveCount(0);
      await light(page, `${project} .otk-status-light[data-state=blocked]`);
      // The compact rail exposes the attention lamp, not the hidden name cell.
      await page.locator(`${project} .otk-project-attention`).click();
      // Decision 7: blocked attention precedes the exact remembered working session.
      await expect(page).toHaveURL(new RegExp(`/${blocked.id}$`));
      await expect(page.locator(".otk-permission-dock")).toBeVisible();
      await expect(page.locator(".otk-permission-dock")).toContainText(
        "scale_blocked",
      );
      const blockedDockEnd = frames.length;
      for (
        const [id, status] of [[finished.id, "finished"], [
          working.id,
          "working",
        ], [blocked.id, "blocked"]]
      ) {
        await light(
          page,
          `[data-tab="${id}"] .otk-status-light[data-state=${status}]`,
        );
      }
      await expect(page.locator(".otk-project-sessions")).toHaveCount(0);
      observations.background = { finished, working, blocked };
      await state.product("layout.patch", {
        leftCollapsed: false,
        rightCollapsed: false,
        rightView: "sessions",
      });
      // The RPC receipt precedes delivery to the open browser. Observe that
      // consumer before navigation can retire its preference stream.
      await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
        "data-collapsed",
        "false",
      );
      await expect(page.locator(".otk-right-panel")).toBeVisible();
      await page.goto(`${state.url}/#/local/${selected.id}`);
      await page.locator(search).fill("");
      const readinessStart = performance.now(), progress: unknown[] = [];
      const readyCount = async () =>
        (await state.observe<Pick<Observation, "readyCount">>({
          fields: ["readyCount"],
        })).readyCount;
      let ready = await readyCount();
      const target = 4619;
      while (ready < target) {
        const previous = ready;
        await expect.poll(readyCount, { timeout: 30_000 })
          .toBeGreaterThan(previous);
        ready = await readyCount();
        progress.push({ elapsed: performance.now() - readinessStart, ready });
      }
      expect(ready).toBe(target);
      await status(working.id, "busy");
      observations.warmReadiness = { target, progress };
      runs.push(await page.evaluate("scale"));
      await page.reload();
      await expect.poll(() => page.evaluate<number>("scale.paints.length"), {
        timeout: 120_000,
      }).toBeGreaterThan(0);
      const warm = await page.evaluate<typeof cold>("scale.paints[0]");
      // Readiness belongs to this view; cross-project attention routes intentionally carry no digest.
      expect(warm.snapshot.ready).toBe(true);
      expect(warm.snapshot.ids).toContain(selected.id);
      expect(warm.snapshot.count).toBeLessThanOrEqual(
        warm.bound + taskMembers.size + 2,
      );
      expect(
        warm.snapshot.ids.filter((id) =>
          !sessions.slice(0, 251).some((session) => session.id === id) &&
          ![liveID, finished.id, working.id, blocked.id].includes(id)
        ),
      ).toEqual([]);
      await status(working.id, "busy");
      const warmState = await state.observe<Observation>();
      expect(warmState.requests.filter((r) => {
        const body = JSON.stringify(r);
        return body.includes("Keep background work active") &&
          !body.includes("Generate a title for this conversation:");
      })).toHaveLength(1);
      observations.warm = warm;
      await expect(
        page.locator(`[data-session="${selected.id}"] .otk-session-cost`),
      ).toHaveText(warmState.expectedCosts[selected.id]);
      expect(
        Math.abs(
          Number(
            await page.locator(".otk-context-meter").getAttribute("data-cost"),
          ) - selected.expected.cost,
        ),
      ).toBeLessThan(1e-8);
      // Newest-first paging does not mount old rows until their list is demanded.
      await page.locator(search).fill("Scale session 000");
      for (const i of [2, 3]) {
        await expect(
          page.locator(`[data-session="${sessions[i].id}"] .otk-session-cost`),
        ).toHaveText(warmState.expectedCosts[sessions[i].id]);
      }
      await expect(
        page.locator(
          `[data-session="${sessions[1].id}"] .otk-session-digest-state`,
        ),
      ).toHaveText("Usage unavailable");
      await page.locator(search).fill(sessions[250].title);
      await expect(
        page.locator(`[data-session="${sessions[250].id}"] .otk-session-cost`),
      ).toHaveText(warmState.expectedCosts[sessions[250].id]);
      await page.locator(search).fill("");
      await expect.poll(async () =>
        Number(await page.locator(viewport).getAttribute("data-acquired-count"))
      ).toBeGreaterThan(2);
      await page.evaluate(framesAhead);
      const allCalls = calls();
      expect(allCalls.filter((f) => f.method === "usage.get")).toHaveLength(0);
      const attention = new Set([finished.id, blocked.id]);
      const attentionReads = requestReads(
        frames,
        [
          { name: "background", start: backgroundStart, end: backgroundEnd },
          { name: "reload-blocked", start: backgroundEnd, end: blockedDockEnd },
          { name: "warm-selected", start: blockedDockEnd, end: frames.length },
        ],
        "permission.list",
        attention,
      );
      observations.attentionReads = attentionReads;
      assertReadDemand(attentionReads, "background");
      assertReadDemand(attentionReads, "reload-blocked", [blocked.id]);
      assertReadDemand(attentionReads, "warm-selected");
      const oldSockets = new Set(
        attentionReads.filter((read) => read.phase === "background").map((
          read,
        ) => read.socket),
      );
      // Reload replaces the socket, not the serving owner's durable request
      // window. Correlate each new read with that socket's real welcome.
      expect(
        attentionReads.filter((read) => read.phase === "reload-blocked").every((
          read,
        ) => !oldSockets.has(read.socket)),
      ).toBe(true);
      for (
        const read of attentionReads.filter((read) =>
          read.phase === "reload-blocked"
        )
      ) {
        const welcome = frames.find((event) =>
          event.socket === read.socket && event.direction === "received" &&
          event.frame.t === "welcome"
        )?.frame as unknown as
          | Extract<import("@otk/protocol").ServerFrame, { t: "welcome" }>
          | undefined;
        expect(welcome).toBeTruthy();
        expect(read.window).toBe(welcome!.requests.window.id);
      }
      let lastHello = -1;
      frames.forEach((e, index) => {
        if (e.direction === "sent" && e.frame.t === "hello") lastHello = index;
      });
      const currentFrames = frames.slice(lastHello);
      const parentWitnesses = listParents(currentFrames);
      observations.listParentWitnesses = Object.fromEntries(parentWitnesses);
      const current = currentFrames.filter((e) =>
        e.direction === "sent" && e.frame.t === "request"
      ).map((e) => e.frame as unknown as Call);
      scoped(
        current,
        selected.id,
        new Set([
          ...taskMembers,
          ...sessions.filter((s) => s.directory === background).map((s) =>
            s.id
          ),
          finished.id,
          working.id,
          blocked.id,
        ]),
        attention,
        parentWitnesses,
      );
      await wheel(100000);
      await expect(page.locator(`[data-session="${last.id}"]`)).toBeAttached();
      expect(await page.locator(".otk-session-row").count()).toBeLessThan(45);
      await expect(
        page.locator(`[data-session="${last.id}"] .otk-session-cost`),
      ).toHaveText(warmState.expectedCosts[last.id]);
      observations.window = await windowBound();
      await page.evaluate(
        `globalThis.pinnedScale=document.querySelector('[data-session="${last.id}"] .otk-session-open');pinnedScale.focus()`,
      );
      await expect(
        page.locator(`[data-session="${last.id}"] .otk-session-open`),
      )
        .toBeFocused();
      await page.evaluate(framesAhead);
      await wheel(-100000);
      await expect.poll(() =>
        page.evaluate(
          "document.activeElement===pinnedScale&&pinnedScale.isConnected",
        )
      ).toBe(true);
      await windowBound(1);
      await page.locator(search).focus();
      await expect(page.locator(`[data-session="${last.id}"]`)).toHaveCount(0);
      await wheel(100000);
      await expect(page.locator(`[data-session="${last.id}"]`)).toBeAttached();
      // Paging arrivals can be held in discovery order while the pointer/focus
      // owns the panel. Retire that interaction, then reveal the target in the
      // settled complete projection before measuring mutation retention.
      await page.locator(".otk-project-tabs").hover();
      await page.locator("textarea[name=prompt]").focus();
      await page.evaluate(framesAhead);
      await wheel(100000);
      const before = await anchor();
      observations.anchors = { before };
      const taskChangeStart = frames.length;
      await state.product("tasks.sessions", {
        id: grouped.id,
        sessions: [sessions[4].id, selected.id],
      });
      // The fixture's RPC receipt is not the open browser's membership stream.
      await expect.poll(() =>
        frames.slice(taskChangeStart).some((event) => {
          const frame = event.frame as unknown as ServerFrame;
          if (event.direction !== "received") return false;
          const tasks = frame.t === "inbox.snapshot"
            ? frame.inbox.tasks
            : frame.t === "inbox.patch"
            ? frame.ops.flatMap((op) =>
              op.op === "task.upsert" ? [op.task] : []
            )
            : [];
          return tasks.some((task) =>
            task.id === grouped.id &&
            JSON.stringify(task.sessions) ===
              JSON.stringify([sessions[4].id, selected.id])
          );
        })
      ).toBe(true);
      await page.evaluate(framesAhead);
      const reordered = await anchor();
      Object.assign(observations.anchors!, { reordered });
      expect(reordered.key).toBe(before.key);
      expect(Math.abs(reordered.offset - before.offset)).toBeLessThan(1);
      const renameBefore = await state.product("session.get", {
        sessionID: last.id,
      });
      await page.locator(`[data-session="${last.id}"]`).click({
        button: "right",
      });
      Object.assign(observations.anchors!, { menu: await anchor() });
      await contextCommand(menu, "session.rename").click();
      await expect(
        page.getByRole("textbox", { name: "Rename session", exact: true }),
      )
        .toBeVisible();
      Object.assign(observations.anchors!, { editor: await anchor() });
      await page.getByRole("textbox", { name: "Rename session", exact: true })
        .fill(last.title + " renamed");
      await page.keyboard.press("Enter");
      await expect(page.locator(".otk-title-editor")).toHaveCount(0);
      await expect(
        page.locator(`[data-session="${last.id}"] .otk-session-title`),
      )
        .toHaveText(last.title + " renamed");
      const renamed = await state.product("session.get", {
        sessionID: last.id,
      });
      expect(renamed.title).toBe(last.title + " renamed");
      expect(renamed.time.updated).toBe(renameBefore.time.updated);
      const edited = await anchor();
      Object.assign(observations.anchors!, { edited });
      expect(edited.key).toBe(before.key);
      expect(Math.abs(edited.offset - before.offset)).toBeLessThan(1);
      await page.locator(search).fill("Scale session 0005");
      await expect(page.locator(".otk-session-row")).toHaveCount(2);
      await expect(page.locator(`[data-session="${sessions[4].id}"]`))
        .toBeAttached();
      for (const width of [280, 480]) {
        await state.product("layout.patch", { rightWidth: width });
        await expect.poll(() =>
          page.locator(".otk-right-panel").evaluate((e) =>
            e.getBoundingClientRect().width
          )
        ).toBe(width);
        await page.evaluate(framesAhead);
        const geometry = await page.evaluate(
          `({aligned:[...document.querySelectorAll('.otk-session-row')].every(row=>{const a=row.querySelector('.otk-status-light').getBoundingClientRect(),b=row.querySelector('.otk-session-title').getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2)<=1}),nowrap:[...document.querySelectorAll('.otk-session-row .otk-session-title')].every(e=>getComputedStyle(e).whiteSpace==='nowrap'),gaps:(()=>{const c=document.querySelector('.otk-panel-new-session').getBoundingClientRect(),i=document.querySelector('.otk-panel-new-session svg').getBoundingClientRect();return [i.left-c.left,c.right-i.right,i.top-c.top,c.bottom-i.bottom]})()})`,
        ) as { aligned: boolean; nowrap: boolean; gaps: number[] };
        expect(geometry.aligned && geometry.nowrap).toBe(true);
        expect(Math.max(...geometry.gaps) - Math.min(...geometry.gaps))
          .toBeLessThanOrEqual(1);
      }
      await page.locator(search).fill("");
      await wheel(-100000);
      await expect(page.locator(`[data-session="${selected.id}"]`))
        .toBeAttached();
      expect(
        await page.locator(".otk-session-row").evaluateAll((rows) =>
          rows.slice(0, 3).map((r) => r.getAttribute("data-session"))
        ),
      ).toEqual([sessions[4].id, sessions[5].id, selected.id]);
      await expect(page.locator(`[data-session="${selected.id}"]`))
        .toHaveAttribute("aria-current", "page");
    } catch (cause) {
      failure = { cause };
    }
    try {
      await info.attach("population-control-measurements", {
        body: JSON.stringify({
          initial,
          observations,
          frames,
          runs: [...runs, await page.evaluate("scale")],
          server: await state.observe(),
        }),
        contentType: "application/json",
      });
    } catch (cause) {
      // A timed-out/closed page must not replace the original assertion.
      if (!failure) throw cause;
      console.error("Could not capture scale measurements:", cause);
    }
    if (failure) throw failure.cause;
  },
);
