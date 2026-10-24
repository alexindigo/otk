// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { AssistantMessage } from "@otk/protocol";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { Cdp } from "../support/cdp.ts";
import { WsClient } from "../support/ws-client.ts";

// Count fragments of each text node, rather than control height: a picker may
// intentionally have a separate subtitle, and icons are not lines of its label.
const audit = `(() => {
  const controls=[...document.querySelectorAll('button,a[href],input[type=button],input[type=submit],[role=button],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=treeitem],[role=checkbox],[role=radio],[role=switch],[role=link],[aria-expanded],summary,h1,h2,h3,h4,h5,h6,[role=heading],.otk-chip,.otk-pill')];
  return controls.filter(el=>!el.matches('.otk-prose-heading,.otk-prose-link') && el.checkVisibility({visibilityProperty:true})).map(el=>{
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT), labels=[];
    for(let node;(node=walker.nextNode());) {
      if(!node.textContent.trim() || !node.parentElement.checkVisibility({visibilityProperty:true}))continue;
      const range=document.createRange();range.selectNodeContents(node);
      const rects=[...range.getClientRects()].filter(r=>r.width && r.height);
      const tops=[];for(const r of rects)if(!tops.some(t=>Math.abs(t-r.top)<1))tops.push(r.top);
      labels.push({text:node.textContent.trim(),lines:tops.length});
    }
    const r=el.getBoundingClientRect();
    return {tag:el.tagName,role:el.getAttribute('role'),disclosure:el.hasAttribute('aria-expanded')||el.matches('summary'),control:el.className,label:el.getAttribute('aria-label'),width:r.width,labels};
  });
})()`;

test("control labels stay single-line across transcript, chrome, menus, pickers and dialogs", async () => {
  const root = await fixture();
  const backendRoot = join(root, "label-audit");
  await Deno.mkdir(backendRoot);
  let attention = "none";
  const longName =
    "Review the complete dependency graph and every affected consumer";
  const reply: AssistantMessage = {
    id: "reply",
    sessionID: "core",
    role: "assistant",
    agent: "build",
    model: { provider: "external", model: "fixture" },
    time: { created: 1792771200000, completed: 1792771204000 },
    tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    interrupted: false,
    parts: [{
      id: "failed",
      kind: "tool",
      call: {
        tool: "external",
        name: "inspect",
        callID: "failed",
        status: "error",
        awaitingPermission: false,
        time: { start: 1792771200000, end: 1792771204000 },
        summary:
          "Inspect the complete dependency graph and every affected consumer before applying the shared correction",
        error: "The requested dependency is unavailable.",
      },
    }, {
      id: "failed-path",
      kind: "tool",
      call: {
        tool: "read",
        callID: "failed-path",
        status: "error",
        awaitingPermission: false,
        path:
          "/workspace/dependencies/complete-graph-and-every-affected-consumer/inspection.ts",
        loaded: [],
        offset: 100,
        limit: 500,
        time: { start: 1792771200000, end: 1792771204000 },
        error: "The requested file is unavailable.",
      },
    }],
  };
  const f = await coreBackendFixture(backendRoot, {
    agents: {
      listAgents: () =>
        Promise.resolve([
          { name: "build" },
          {
            name:
              "review the complete dependency graph and every affected consumer",
          },
        ]),
    },
    prompt: { prompt: () => Promise.resolve(), abort: () => Promise.resolve() },
    permissions: {
      listPermissions: () =>
        Promise.resolve(
          attention === "permission"
            ? [{
              id: "permission",
              sessionID: "core",
              kind: "bash",
              title: "Inspect dependencies",
              patterns: ["git status *"],
              alwaysPatterns: ["git status *"],
              detail: { kind: "bash", command: "git status --short" },
              time: 1792771200000,
            }]
            : [],
        ),
      replyPermission: () => Promise.resolve(),
    },
    questions: {
      listQuestions: () =>
        Promise.resolve(
          attention === "question"
            ? [{
              id: "question",
              sessionID: "core",
              questions: [{
                header: "Dependency review",
                text: "Which review should run?",
                options: [{ label: longName, description: longName }],
                multiple: false,
                custom: true,
              }],
            }]
            : [],
        ),
      answerQuestion: () => Promise.resolve(),
    },
    models: {
      listModels: () =>
        Promise.resolve({
          providers: [{
            id: "external",
            name:
              "External provider for the complete dependency graph and every affected consumer",
            models: [{
              id: "fixture",
              name: longName,
              variants: [],
              status: "active",
              free: false,
            }],
          }],
        }),
    },
  });
  f.app.backend.core.listMessages = () => Promise.resolve([reply]);
  const b = await Cdp.launch(root), client = new WsClient(f.url);
  const results: unknown[] = [], failures: unknown[] = [];
  const shots = Deno.env.get("OTK_LABEL_SHOTS");
  if (shots) await Deno.mkdir(shots, { recursive: true });
  try {
    await client.connect();
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await client.rpc("prefs.set", { key: "timestamps", value: true });
    const inactive = join(root, "inactive-project");
    await Deno.mkdir(inactive);
    await client.rpc("projects.visit", { directory: inactive, active: true });
    await client.rpc("projects.inactive", {
      directory: inactive,
      inactive: true,
    });
    await b.goto(`${f.url}/#/local/core`);
    await b.poll(
      "!!document.querySelector('.otk-tool-error-toggle') && !!document.querySelector('.otk-agent-picker > button')",
    );
    await b.evaluate("document.fonts.ready");
    await client.rpc("tasks.create", {
      directory: backendRoot,
      name: longName,
    });
    await b.poll("!!document.querySelector('[data-kind=task]')");
    await b.poll("!!document.querySelector('.otk-inactive-toggle')");
    for (const theme of ["otk-dark", "otk-light"]) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      for (const width of [1280, 800]) {
        await b.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 800,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const inspect = async (screen: string) => {
          await b.evaluate(
            "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
          );
          const controls = await b.evaluate<
            {
              tag: string;
              role: string | null;
              disclosure: boolean;
              labels: { text: string; lines: number }[];
            }[]
          >(audit);
          assert(controls.length > 0, screen);
          const wraps = controls.filter((c) =>
            c.labels.some((l) => l.lines > 1)
          );
          results.push({
            theme,
            width,
            screen,
            count: controls.length,
            headings: controls.filter((c) =>
              /^H[1-6]$/.test(c.tag) || c.role === "heading"
            ),
            disclosures: controls.filter((c) => c.disclosure),
            wraps,
          });
          failures.push(
            ...wraps.map((control) => ({ theme, width, screen, control })),
          );
          if (
            shots &&
            ["transcript", "agent", "model", "sessions-panel"].includes(screen)
          ) {
            await b.screenshot(join(shots, `${theme}-${width}-${screen}.png`));
          }
        };
        await inspect("transcript");
        const geometry = await b.evaluate<
          { fits: boolean; text: string; ellipsis: string; clipped: boolean }
        >(`(() => {
          const action=document.querySelector('.otk-tool-error-toggle'), row=action.parentElement, summary=document.querySelector('.otk-tool-brief');
          const r=row.getBoundingClientRect(),a=action.getBoundingClientRect(),s=summary.getBoundingClientRect();
          return {fits:a.right<=r.right+.5 && s.right<=a.left+.5 && action.scrollWidth<=action.clientWidth,
            text:summary.title,ellipsis:getComputedStyle(summary).textOverflow,clipped:summary.scrollWidth>summary.clientWidth};
        })()`);
        if (
          !geometry.fits ||
          !geometry.text.includes("every affected consumer") ||
          geometry.ellipsis !== "ellipsis" || !geometry.clipped
        ) failures.push({ theme, width, geometry });
        await b.click(".otk-tool-error-toggle");
        await b.poll("!!document.querySelector('.otk-tool-error[role=alert]')");
        await inspect("error-details");
        await b.click(".otk-tool-error-toggle");
        await b.click(".otk-agent-picker > button");
        await b.poll("!!document.querySelector('.otk-picker-option')");
        await inspect("agent");
        const clipped = await b.evaluate<boolean>(
          `[...document.querySelectorAll('.otk-picker-option span[title]')].some(el=>el.scrollWidth>el.clientWidth && el.title===el.textContent && getComputedStyle(el).textOverflow==='ellipsis')`,
        );
        if (!clipped) {
          failures.push({
            theme,
            width,
            error: "Long picker label must ellipsize with its complete title",
          });
        }
        await b.key("Escape");
        await b.click(".otk-model-picker > button");
        await b.poll("!!document.querySelector('.otk-picker-option')");
        await inspect("model");
        const heading = await b.evaluate<boolean>(
          `[...document.querySelectorAll('.otk-picker-groups h3')].some(el=>el.title===el.textContent&&el.scrollWidth>el.clientWidth&&getComputedStyle(el).textOverflow==='ellipsis')`,
        );
        if (!heading) {
          failures.push({
            theme,
            width,
            error: "Long picker heading must ellipsize with its complete title",
          });
        }
        await b.key("Escape");
        await b.evaluate("document.querySelector('.otk-tool-toggle').focus()");
        await b.key("F10", 8);
        await b.poll("!!document.querySelector(':popover-open [role=menu]')");
        await inspect("context-menu");
        await b.key("Escape");
        await b.click('[aria-label="Open right panel"]');
        await b.poll("!document.querySelector('.otk-right-panel').hidden");
        await inspect("sessions-panel");
        const section = await b.evaluate<boolean>(
          `[...document.querySelectorAll('.otk-session-group h3 .otk-control-label')].some(el=>el.title===${
            JSON.stringify(longName)
          }&&el.textContent===el.title&&el.scrollWidth>el.clientWidth&&getComputedStyle(el).textOverflow==='ellipsis'&&el.getBoundingClientRect().right<=el.parentElement.getBoundingClientRect().right+.5)`,
        );
        if (!section) {
          failures.push({
            theme,
            width,
            error:
              "Long session heading must ellipsize with its complete title",
          });
        }
        const crowded = await b.evaluate<{ fits: boolean; sameRow: boolean }[]>(
          `[...document.querySelectorAll('.otk-tool-toggle')].map(el=>{
          const row=el.parentElement,action=row.querySelector('.otk-tool-error-toggle');
          const e=el.getBoundingClientRect(),a=action.getBoundingClientRect(),r=row.getBoundingClientRect();
          const sameRow=Math.abs((e.top+e.bottom-a.top-a.bottom)/2)<.5;
          return {sameRow,fits:el.scrollWidth<=el.clientWidth && e.right<=r.right+.5 && a.right<=r.right+.5 && (sameRow ? e.right<=a.left : a.top>=e.bottom)};
        })`,
        );
        if (
          crowded.some((row) => !row.fits || row.sameRow !== (width === 1280))
        ) failures.push({ theme, width, crowded });
        const footer = await b.evaluate<
          {
            overlaps: string[][];
            overflow: string[];
            outside: string[];
            actionCentres: number[];
          }
        >(`(()=>{
          const controls=[...document.querySelectorAll('.otk-prompt-actions button')].filter(el=>el.checkVisibility());
          const name=el=>el.getAttribute('aria-label')||el.textContent;
          const footer=document.querySelector('.otk-prompt-actions').getBoundingClientRect();
          return {actionCentres:[...document.querySelectorAll('.otk-prompt-actions > button')].map(el=>{const r=el.getBoundingClientRect();return r.top+r.height/2}),outside:controls.filter(el=>{const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return r.left<Math.max(footer.left,p.left)-.5||r.right>Math.min(footer.right,p.right)+.5}).map(name),overflow:controls.filter(el=>el.scrollWidth>el.clientWidth+1).map(name),overlaps:controls.flatMap((el,i)=>controls.slice(i+1).flatMap(other=>{
            const a=el.getBoundingClientRect(),b=other.getBoundingClientRect();
            return Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1 ? [[name(el),name(other)]]:[];
          }))};
        })()`);
        if (
          footer.overlaps.length || footer.overflow.length ||
          footer.outside.length ||
          Math.max(...footer.actionCentres) -
                Math.min(...footer.actionCentres) > .5
        ) {
          failures.push({ theme, width, footer });
        }
        await b.click('[aria-label="Collapse right panel"]');
        await b.poll("document.querySelector('.otk-right-panel').hidden");
        await b.click(".otk-display-menu > button");
        await b.poll(
          "!!document.querySelector('.otk-display-menu :popover-open')",
        );
        await inspect("display");
        await b.key("Escape");
        for (
          const [query, command, ready] of [
            ["Settings", "settings.open", ".otk-settings"],
            ["theme", "theme.open", ".otk-theme-choices"],
            ["Keyboard shortcuts", "help.keys", ".otk-keys-list"],
            ["Edit prompt", "prompt.editor", ".otk-editor"],
          ]
        ) {
          await b.key("k", 2);
          await b.poll(
            "!!document.querySelector('input[name=command-search]')",
          );
          await inspect("palette");
          await b.fill("input[name=command-search]", query);
          const exists = await b.evaluate(
            `!!document.querySelector('[data-command="${command}"]')`,
          );
          if (!exists) throw new Error(`Missing ${command}`);
          await b.click(`[data-command="${command}"]`);
          await b.poll(`!!document.querySelector('${ready}')`);
          await inspect(command);
          if (command === "settings.open") {
            await b.click(".otk-settings .otk-view-header button");
          } else await b.key("Escape");
        }
        for (const pending of ["permission", "question"]) {
          attention = pending;
          await b.reload();
          await b.poll(`!!document.querySelector('.otk-${pending}-dock')`);
          await inspect(pending);
        }
        attention = "none";
        await b.reload();
        await b.poll(
          "!!document.querySelector('.otk-tool-error-toggle') && !document.querySelector('.otk-question-dock')",
        );
      }
    }
    console.info("Control label audit", JSON.stringify(results));
    await Deno.writeTextFile(
      join(root, "labels.json"),
      JSON.stringify(results, null, 2),
    );
    console.info("Control label evidence", root);
    assertEquals(failures, []);
    assertEquals(b.errors, []);
  } finally {
    await client.close();
    await b.close();
    await f.app.stop();
  }
});
