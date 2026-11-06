// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";
import { scaleWire } from "../fixtures/scale-wire.ts";
import type { Page } from "@playwright/test";

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
  entries: { id: string; status: string; attention: { permissions: number } }[];
  taskMembers: string[];
  expectedCosts: Record<string, string>;
  requests: unknown[];
}
interface Call {
  t: string;
  method: string;
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
function scoped(
  calls: Call[],
  selected: string,
  members: Set<string>,
  attention = new Set<string>(),
) {
  const reads = new Map<string, unknown[]>();
  for (const frame of calls) {
    const params = frame.params, id = params?.sessionID;
    if (!id || id === selected) continue;
    if (frame.method === "permission.list" && attention.has(id)) continue;
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
test(
  "scale.cold-warm-windows-interactive-supervision",
  { tag: ["@scale"] },
  async ({ isolatedState: state, page }, info) => {
    test.setTimeout(900_000);
    const initial = await state.observe<Observation>();
    expect(initial.counts).toEqual(initial.expectedCounts);
    const sessions = initial.manifest.sessions,
      selected = sessions[0],
      background = sessions[251].directory;
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
    await page.addInitScript(`(()=>{
    const Native=WebSocket,titles=new Set(${
      JSON.stringify([
        ...sessions.slice(0, 251).map((s) => s.title),
        "Scale interactive outcome",
      ])
    });globalThis.scale={snapshots:[],calls:[],cancels:[],results:[],paints:[]};
    globalThis.WebSocket=class extends Native{
      constructor(...args){super(...args);this.addEventListener('message',event=>{const f=JSON.parse(event.data),at=performance.now();if(f.t==='request.result')scale.results.push({at,wall:Date.now(),...f,id:f.ref.key,ok:f.outcome.ok});const entries=f.t==='index.snapshot'?f.entries:f.t==='index.patch'?f.ops.filter(op=>op.op==='upsert').map(op=>op.entry):[];if(!entries.some(e=>e.id==='${selected.id}')||!location.hash.endsWith('/${selected.id}'))return;
      const snapshot={at,ready:entries.every(e=>e.digest.state==='ready'),count:entries.length,unready:entries.filter(e=>e.digest.state!=='ready').slice(0,20).map(e=>({id:e.id,state:e.digest.state,revision:e.digest.revision}))};scale.snapshots.push(snapshot);
      const paint=()=>{const rows=[...document.querySelectorAll('.otk-session-row')],v=document.querySelector('${viewport}'),chosen=document.querySelector('[data-session="${selected.id}"]'),boxes=rows.map(r=>r.getBoundingClientRect()),bound=v?Math.ceil(v.clientHeight/Math.min(...boxes.map(r=>r.height)))+12:0;const valid=rows.length>0&&rows.length<=bound&&v&&chosen?.getAttribute('aria-current')==='page'&&rows.every((row,i)=>boxes[i].width>0&&boxes[i].height>0&&row.querySelector('.otk-status-light')&&titles.has(row.querySelector('.otk-row-title')?.textContent));if(valid)scale.paints.push({snapshot,at:performance.now(),elapsed:performance.now()-at,rows:rows.length,bound});else requestAnimationFrame(paint)};requestAnimationFrame(paint);});}
      send(data){const f=JSON.parse(data);if(f.t==='request')scale.calls.push({at:performance.now(),wall:Date.now(),...f,id:f.ref.key});if(f.t==='request.release')scale.cancels.push(...f.refs.map(ref=>({at:performance.now(),id:ref.key,ref})));super.send(data);}
    };
  })()`);
    const status = (id: string, value: string) =>
      expect.poll(async () =>
        (await state.observe<Observation>()).entries.find((e) => e.id === id)
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
      const r = await page.locator(viewport).boundingBox();
      expect(r).toBeTruthy();
      await page.mouse.move(r!.x + r!.width / 2, r!.y + r!.height / 2);
      await page.mouse.wheel(0, delta);
    };
    const anchor = () =>
      page.locator(viewport).evaluate((v) => {
        const r = v.getBoundingClientRect(),
          e = Array.from(v.querySelectorAll<HTMLElement>("[data-virtual-key]"))
            .find((e) => e.getBoundingClientRect().bottom > r.top + .5)!;
        return {
          key: e.dataset.virtualKey,
          offset: e.getBoundingClientRect().top - r.top,
        };
      });
    try {
      await page.goto(`${state.url}/#/local/${selected.id}`);
      await expect.poll(() => page.evaluate<number>("scale.paints.length"), {
        timeout: 120_000,
      }).toBeGreaterThan(0);
      const cold = await page.evaluate<
        { elapsed: number; snapshot: { ready: boolean; count: number } }
      >("scale.paints[0]");
      expect(cold.snapshot.ready).toBe(false);
      observations.cold = cold;
      const taskMembers = new Set(
        (await state.observe<Observation>()).taskMembers,
      );
      expect(calls().filter((f) => f.method === "usage.get")).toEqual([]);
      scoped(calls(), selected.id, taskMembers);
      await expect.poll(
        async () =>
          (await state.observe<{ frames: { t: string; state?: string }[] }>())
            .frames.some((frame) =>
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
      await menu.locator('[data-context-command^="task.rename:"]').click();
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
        liveID = `opcv1-${live.id}`;
      await page.locator(search).fill("Scale interactive outcome");
      await page.locator(`[data-session="${liveID}"]`).click();
      await expect(page.locator("textarea[name=prompt]")).toBeVisible();
      const held = await state.queue(["Scale accepted reply"], "held");
      await page.locator("textarea[name=prompt]").fill(
        "Scale interactive prompt",
      );
      await page.keyboard.press("Enter");
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
      await page.keyboard.press("Enter");
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
        return { native: s.id, id: `opcv1-${s.id}` };
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
          (await state.observe<Observation>()).requests.filter((r) => {
            const body = JSON.stringify(r);
            return body.includes(text) &&
              !body.includes("Generate a title for this conversation:");
          }).length
        ).toBeGreaterThan(0);
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
        (await state.observe<Observation>()).entries.find((e) =>
          e.id === finished.id
        )?.attention.permissions ?? 0
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
        (await state.observe<Observation>()).entries.find((e) =>
          e.id === blocked.id
        )?.attention.permissions ?? 0
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
      await page.reload();
      await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
        "data-collapsed",
        "true",
      );
      await expect(page.locator(".otk-right-panel")).toBeHidden();
      await expect(page.locator(".otk-project-sessions")).toHaveCount(0);
      await light(page, `${project} .otk-status-light[data-state=blocked]`);
      await page.locator(`${project} .otk-project-open`).click();
      await expect(page).toHaveURL(new RegExp(`/${working.id}$`));
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
      await page.goto(`${state.url}/#/local/${selected.id}`);
      await page.locator(search).fill("");
      const readinessStart = performance.now(), progress: unknown[] = [];
      let ready = (await state.observe<Observation>()).ready.length;
      const target = 4619;
      while (ready < target) {
        const previous = ready;
        await expect.poll(
          async () => (await state.observe<Observation>()).ready.length,
          { timeout: 30_000 },
        ).toBeGreaterThan(previous);
        ready = (await state.observe<Observation>()).ready.length;
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
      expect(warm.snapshot.ready).toBe(true);
      expect(warm.snapshot.count).toBe(target);
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
      for (const i of [2, 3]) {
        await expect(
          page.locator(`[data-session="${sessions[i].id}"] .otk-session-cost`),
        ).toHaveText(warmState.expectedCosts[sessions[i].id]);
      }
      await expect(
        page.locator(
          "[data-session=opcv1-ses_scale000001] .otk-session-digest-state",
        ),
      ).toHaveText("Usage unavailable");
      const allCalls = calls();
      expect(allCalls.filter((f) => f.method === "usage.get")).toHaveLength(0);
      const attention = new Set([finished.id, blocked.id]),
        attentionReads = allCalls.filter((f) =>
          f.method === "permission.list" &&
          attention.has(f.params?.sessionID ?? "")
        );
      expect(attentionReads).toHaveLength(2);
      observations.attentionReads = attentionReads;
      let lastHello = -1;
      frames.forEach((e, index) => {
        if (e.direction === "sent" && e.frame.t === "hello") lastHello = index;
      });
      const current = frames.slice(lastHello).filter((e) =>
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
      );
      const last = sessions[250];
      await wheel(100000);
      await expect(page.locator(`[data-session="${last.id}"]`)).toBeAttached();
      expect(await page.locator(".otk-session-row").count()).toBeLessThan(45);
      await expect(
        page.locator(`[data-session="${last.id}"] .otk-session-cost`),
      ).toHaveText(warmState.expectedCosts[last.id]);
      observations.window = await windowBound();
      await page.evaluate(
        `globalThis.pinnedScale=document.querySelector('[data-session="${last.id}"]');pinnedScale.focus()`,
      );
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
      const before = await anchor();
      await state.product("tasks.sessions", {
        id: grouped.id,
        sessions: [sessions[4].id, selected.id],
      });
      await page.evaluate(framesAhead);
      const reordered = await anchor();
      expect(reordered.key).toBe(before.key);
      expect(Math.abs(reordered.offset - before.offset)).toBeLessThan(1);
      await page.locator(`[data-session="${last.id}"]`).click({
        button: "right",
      });
      await menu.locator('[data-context-command^="session.rename"]').click();
      await page.getByRole("textbox", { name: "Rename session", exact: true })
        .fill(last.title + " renamed");
      await page.keyboard.press("Enter");
      await expect(page.locator(".otk-title-editor")).toHaveCount(0);
      await expect(page.locator(`[data-session="${last.id}"] .otk-row-title`))
        .toHaveText(last.title + " renamed");
      expect((await state.product("session.get", { sessionID: last.id })).title)
        .toBe(last.title + " renamed");
      const edited = await anchor();
      expect(edited.key).toBe(before.key);
      expect(Math.abs(edited.offset - before.offset)).toBeLessThan(1);
      await page.locator(search).fill("Scale session 0005");
      await expect(page.locator(".otk-session-row")).toHaveCount(2);
      await expect(page.locator("[data-session=opcv1-ses_scale000004]"))
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
          `({aligned:[...document.querySelectorAll('.otk-session-row')].every(row=>{const a=row.querySelector('.otk-status-light').getBoundingClientRect(),b=row.querySelector('.otk-row-title').getBoundingClientRect();return Math.abs(a.y+a.height/2-b.y-b.height/2)<=1}),nowrap:[...document.querySelectorAll('.otk-session-row .otk-row-title')].every(e=>getComputedStyle(e).whiteSpace==='nowrap'),gaps:(()=>{const c=document.querySelector('.otk-panel-new-session').getBoundingClientRect(),i=document.querySelector('.otk-panel-new-session svg').getBoundingClientRect();return [i.left-c.left,c.right-i.right,i.top-c.top,c.bottom-i.bottom]})()})`,
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
    } finally {
      await info.attach("population-control-measurements", {
        body: JSON.stringify({
          initial,
          observations,
          runs: [...runs, await page.evaluate("scale")],
          server: await state.observe(),
        }),
        contentType: "application/json",
      });
    }
  },
);
