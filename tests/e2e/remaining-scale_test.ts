// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { OtkDb } from "@otk/store";
import { start } from "../../main.ts";
import { cfg } from "../support/config.ts";
import { beta2Migrations } from "../support/beta1-state.ts";
import { Cdp } from "../support/cdp.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { freePort, waitFor } from "../support/opencode.ts";
import { resources, tempDir, test } from "../support/resources.ts";
import { SCALE, SessionScale } from "../support/session-scale.ts";
import {
  remainingFiles,
  RemainingMeasurements,
} from "../support/remaining-measurements.ts";
import { sentFrames } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import {
  assertCatalogGenerations,
  catalogGenerations,
  generationDemandReady,
  observeCatalogWatches,
} from "../support/remaining-generations.ts";

test("remaining complete catalogs and keyed task outcomes reach Chromium during full-population backfill", async () => {
  // Chromium adds its singleton socket below this disk-backed temp tree.
  const root = await tempDir("rb-"), fake = new FakeLlm();
  const report = new RemainingMeasurements(root, "remaining-browser-scale");
  const native = await SessionScale.create(join(root, "native"), root, fake, {
    files: true,
  });
  await Deno.writeTextFile(
    join(root, "scale-manifest.json"),
    JSON.stringify(native.manifest, null, 2),
  );
  const files = await report.time(
    "generate-files",
    () => remainingFiles(native.directory),
  );
  assertEquals(files.length, 10000);
  const settings = cfg();
  settings.auth.type = "none";
  settings.server.port = freePort();
  settings.state.path = join(root, "state");
  settings.harness.url = native.url;
  settings.harness.db = native.db;
  const db = new OtkDb(settings.state.path, beta2Migrations, settings.storage);
  db.transaction(() => {
    const task = db.connection.prepare("INSERT INTO tasks VALUES(?,?,?,?)");
    const member = db.connection.prepare(
      "INSERT INTO task_sessions VALUES(?,?,0)",
    );
    for (let n = 0; n < SCALE.projectSessions; n++) {
      task.run(
        `scale-task-${n}`,
        native.directory,
        `Qualification task ${n}`,
        n,
      );
      member.run(`scale-task-${n}`, native.manifest.sessions[n].id);
    }
  });
  db.close();
  const app = await start(settings);
  resources().defer("remaining scale application", () => app.stop());
  const watches = observeCatalogWatches(app.backend);
  resources().defer("catalog watch observation", () => watches.restore());
  const client = new WsClient(`http://127.0.0.1:${settings.server.port}`);
  await client.connect();
  const browser = await Cdp.launch(root), target = native.manifest.sessions[0];
  await browser.send("Page.addScriptToEvaluateOnNewDocument", {
    source:
      `globalThis.remainingDemand=[];globalThis.remainingSockets=[];(()=>{const Native=WebSocket;globalThis.WebSocket=class extends Native{constructor(...args){super(...args);remainingSockets.push(this)}};const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){const frame=JSON.parse(data);if(typeof frame.method==='string'&&/^(catalogs\\.|frecency\\.)/.test(frame.method))remainingDemand.push({method:frame.method,at:performance.now(),stack:new Error().stack});return send.call(this,data)}})()`,
  });
  const layout = () =>
    browser.evaluate(
      `(()=>{const selectors=['.otk-app','.otk-main','.otk-project-tabs','.otk-task-list','.otk-session-view','.otk-prompt','textarea[name=prompt]'];return {viewport:{width:innerWidth,height:innerHeight},regions:Object.fromEntries(selectors.map(selector=>{const e=document.querySelector(selector);return [selector,e?{box:e.getBoundingClientRect().toJSON(),overflow:getComputedStyle(e).overflow,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}:null]}))}})()`,
    );
  resources().evidence("remaining scale consumer state", async () => {
    await Deno.writeTextFile(
      join(root, "remaining-browser.html"),
      await browser.evaluate<string>("document.documentElement.outerHTML"),
    );
    await Deno.writeTextFile(
      join(root, "provider-requests.json"),
      JSON.stringify(fake.requests, null, 2),
    );
    await Deno.writeTextFile(
      join(root, "remaining-browser.json"),
      JSON.stringify(
        {
          layout: await layout(),
          errors: browser.errors,
          frames: sentFrames(browser),
          watches: watches.records,
          generations: catalogGenerations(browser.events),
          demand: await browser.evaluate("globalThis.remainingDemand"),
          received: browser.events.filter((event) =>
            event.method === "Network.webSocketFrameReceived"
          ).map((event) => {
            const frame = JSON.parse(
              (event.params.response as { payloadData: string }).payloadData,
            );
            return { time: event.params.timestamp, frame };
          }).filter((event) =>
            event.frame.t.startsWith("catalog.") ||
            event.frame.t === "welcome" || event.frame.t === "harness"
          ),
          console: browser.events.filter((event) =>
            event.method === "Runtime.consoleAPICalled"
          ),
        },
        null,
        2,
      ),
    );
  });
  const url = `http://127.0.0.1:${settings.server.port}/#/local/${target.id}`;
  const paintStart = performance.now();
  await browser.goto(url);
  await browser.poll(
    "!!document.querySelector('textarea[name=prompt]') && document.querySelectorAll('.otk-task-list [data-tab]').length>=251",
    120000,
  );
  const paintMs = performance.now() - paintStart;
  await Deno.writeTextFile(
    join(root, "remaining-layout-before-input.json"),
    JSON.stringify(await layout(), null, 2),
  );
  await browser.fill("textarea[name=prompt]", "@candidate-09999");
  await browser.poll(
    "document.querySelector('.otk-autocomplete')?.textContent.includes('candidate-09999.txt')",
    120000,
  );
  const requests = () =>
    sentFrames(browser).filter(({ frame }) =>
      typeof frame.method === "string" &&
      /^(catalogs\.|agents\.list|models\.list|commands\.list|resources\.list|find\.files|frecency\.list)/
        .test(frame.method)
    );
  const before = requests().length;
  const auditDemand = async (closed = false) => {
    await waitFor(() => generationDemandReady(browser.events), Boolean);
    const generations = catalogGenerations(browser.events).filter(
      (generation) => generation.welcomes,
    );
    await waitFor(() =>
      watches.records.length >= generations.length &&
      (closed ? watches.records : watches.records.slice(0, -1)).every((watch) =>
        watch.releases === 1 && watch.unsubscriptions === 1 && watch.aborted
      ), Boolean);
    return assertCatalogGenerations(
      browser.events,
      watches.records,
      native.directory,
      closed,
    );
  };
  await auditDemand();
  for (let n = 0; n < 100; n++) {
    await browser.fill(
      "textarea[name=prompt]",
      `@candidate-${String(n).padStart(5, "0")}`,
    );
  }
  await browser.fill("textarea[name=prompt]", "");
  await browser.poll("!document.querySelector('.otk-autocomplete')");
  await browser.click("textarea[name=prompt]");
  for (let n = 0; n < 100; n++) await browser.key("Tab");
  let generations = await auditDemand();
  // Exercise real retirement even on a faster guest that does not reconnect
  // spontaneously during the measured typing/cycling workload.
  if (generations.length === 1) {
    await browser.evaluate(
      "remainingSockets.filter(socket=>socket.readyState===WebSocket.OPEN).forEach(socket=>socket.close())",
    );
    await waitFor(
      () =>
        catalogGenerations(browser.events).filter((generation) =>
          generation.welcomes
        ).length,
      (count) => count >= 2,
    );
    await browser.poll(
      "document.querySelector('.otk-connection-light')?.dataset.connectionState==='connected'",
    );
    generations = await auditDemand();
  }
  assert(generations.length >= 2);
  await client.rpc("tasks.rename", {
    id: "scale-task-0",
    name: "Current scale task",
  });
  await browser.poll(
    "document.querySelector('[data-tab=scale-task-0]')?.textContent.includes('Current scale task')",
  );
  await Deno.writeTextFile(
    join(native.directory, "catalog/group-99/new-after-watch.txt"),
    "Watch update",
  );
  await browser.fill("textarea[name=prompt]", "@new-after-watch");
  await browser.poll(
    "document.querySelector('.otk-autocomplete')?.textContent.includes('new-after-watch.txt')",
  );
  generations = await auditDemand();
  await browser.fill("textarea[name=prompt]", "@candidate-09999");
  await browser.poll(
    "document.querySelector('.otk-autocomplete')?.textContent.includes('candidate-09999.txt')",
  );
  await browser.key("Enter");
  await browser.poll(
    "document.querySelector('.otk-prompt-chip')?.textContent.includes('candidate-09999.txt')",
  );
  fake.queue({ chunks: ["The last complete catalog candidate arrived."] });
  await browser.poll(
    "!!document.querySelector('.otk-prompt button[type=submit]')",
  );
  await browser.click(".otk-prompt button[type=submit]");
  await browser.poll(
    "[...document.querySelectorAll('.otk-text')].some(e=>e.textContent==='The last complete catalog candidate arrived.')",
    120000,
  );
  await waitFor(
    () => app.index.get(target.id)?.status,
    (status) => status === "idle",
  );
  assert(
    fake.requests.some((request) =>
      JSON.stringify(request.messages).includes(
        "Private candidate 9999 contents",
      )
    ),
  );
  // Welcome can precede bounded bootstrap. Join the canonical reduced index,
  // then observe a complete wire baseline rather than assuming the first one
  // already included every later bootstrap patch.
  await waitFor(
    () =>
      native.manifest.sessions.filter((row) => !!client.entry(row.id)).length,
    (count) => count === SCALE.sessions,
  );
  const snapshotsBefore =
    client.frames.filter((frame) => frame.t === "index.snapshot").length;
  client.send({ t: "resnapshot" });
  await waitFor(
    () => client.frames.filter((frame) => frame.t === "index.snapshot"),
    (snapshots) =>
      snapshots.length > snapshotsBefore &&
      snapshots.at(-1)?.entries.length === SCALE.sessions,
  );
  assertEquals(
    client.frames.filter((frame) => frame.t === "inbox.snapshot").length,
    1,
  );
  const shots = Deno.env.get("OTK_REMAINING_SHOTS");
  for (const theme of ["otk-dark", "otk-light"]) {
    await client.rpc("prefs.set", { key: "theme", value: theme });
    await browser.poll(
      `document.documentElement.dataset.otkTheme==='${theme}'`,
    );
    if (shots) {
      await Deno.mkdir(shots, { recursive: true });
      await browser.screenshot(join(shots, `remaining-scale-${theme}.png`));
    }
  }
  const observations = {
    counts: SCALE,
    tasks: 251,
    files: 10000,
    paintMs,
    localEdits: 100,
    localCycles: 100,
    additionalCatalogRequests: requests().length - before,
    generations,
    acquisitionsPerGeneration: 2,
    catalogRefreshes: 0,
    retiredWatchLeasesReleased: true,
    renderedTasks: await browser.evaluate(
      "document.querySelectorAll('.otk-task-list [data-tab]').length",
    ),
    completeCandidateAtProvider: true,
    initialInboxBaselines: 1,
  };
  assertEquals(browser.errors, []);
  await resources().capture();
  await client.close();
  await browser.close();
  await auditDemand(true);
  await report.write({
    ...observations,
    watches: watches.records,
    activeWatchLeasesAfterClose: 0,
  });
  await app.stop();
});
