// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join, resolve } from "@std/path";
import { start } from "../../main.ts";
import { staticResponse } from "../../core/mod.ts";
import { cfg } from "../support/config.ts";
import { Cdp } from "../support/cdp.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { measureSessionHeap } from "../support/heap.ts";
import {
  captureMessageHeap,
  messageHeapRetention,
  workerHeapPort,
} from "../support/message-heap.ts";
import { freePort, waitFor } from "../support/opencode.ts";
import { resources, tempDir, test } from "../support/resources.ts";
import { SessionScale } from "../support/session-scale.ts";
import {
  MESSAGE_CASES,
  PAYLOAD_BYTES,
} from "../support/message-scale-cases.ts";

test("ten full native scale body cycles report retained heap with another session's highlight worker alive", async () => {
  const root = await tempDir("hm-"), fake = new FakeLlm();
  const heapDirectory = join(
    resolve(Deno.env.get("OTK_TEST_ARTIFACTS") ?? ".test-state/artifacts"),
    `message-heaps-${crypto.randomUUID()}`,
  );
  await Deno.mkdir(heapDirectory, { recursive: true });
  const native = await SessionScale.create(join(root, "fixture"), root, fake, {
    messages: true,
    payload: true,
  });
  const assets = join(root, "consumer-dist");
  const built = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:vite@8.2.0",
      "build",
      "--config",
      "tests/support/message-heap-consumer/vite.config.ts",
      "--outDir",
      assets,
      "--logLevel",
      "warn",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(built.code, 0, new TextDecoder().decode(built.stderr));
  const ui = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) =>
      staticResponse(new URL(request.url).pathname, { staticRoot: assets }),
  );
  resources().defer("heap public consumer server", () => ui.shutdown());
  const uiURL = `http://127.0.0.1:${(ui.addr as Deno.NetAddr).port}`;
  const config = cfg();
  config.auth.type = "none";
  config.server.port = freePort();
  config.server.origins = [uiURL];
  config.state.path = join(root, "state");
  config.harness.url = native.url;
  config.harness.db = native.db;
  config.messages.coolms = 1000;
  const app = await start(config);
  resources().defer("heap native sidecar", () => app.stop());
  const a = native.manifest.sessions[0],
    b = native.manifest.sessions[MESSAGE_CASES.code];
  const pages: { at: number; before: boolean }[] = [];
  const read = app.backend.core.listMessages.bind(app.backend.core);
  app.backend.core.listMessages = (...args) => {
    if (args[0] === a.id) {
      pages.push({
        at: performance.now(),
        before: args[1].before !== undefined,
      });
    }
    return read(...args);
  };
  const browser = await Cdp.launch(root);
  let phase = "consumer startup";
  resources().evidence("heap consumer state", async () => {
    await Deno.writeTextFile(
      join(root, "heap-consumer.html"),
      await browser.evaluate<string>("document.documentElement.outerHTML"),
    );
    await Deno.writeTextFile(
      join(root, "heap-consumer.json"),
      JSON.stringify({ phase, errors: browser.errors, heapDirectory }),
    );
  });
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const url = new URL(uiURL);
  url.searchParams.set("api", `http://127.0.0.1:${config.server.port}`);
  url.searchParams.set("a", a.id);
  url.searchParams.set("b", b.id);
  url.searchParams.set("directory", a.directory);
  url.searchParams.set("oldest", "msg_scale000000000");
  await browser.goto(url.toString());
  await waitFor(
    async () => {
      return browser.errors.length > 0 ||
        await browser.evaluate<boolean>(
          "document.querySelectorAll('.heap-preview .otk-token').length>0",
        );
    },
    Boolean,
    60000,
  );
  assertEquals(browser.errors, []);
  const { targetInfos } = await browser.send("Target.getTargets");
  const target = (targetInfos as { type: string; targetId: string }[]).find((
    t,
  ) => t.type === "worker")!;
  assert(
    target,
    "the independent code-session preview starts the shared worker",
  );
  const worker = await workerHeapPort(browser, target.targetId);
  resources().defer("heap highlight attachment", () => worker.close());
  const observations: unknown[] = [];
  resources().evidence(
    "native body dominator measurements",
    () =>
      Deno.writeTextFile(
        join(root, "body-cooling.json"),
        JSON.stringify(
          {
            heapDirectory,
            version: native.manifest.version,
            counts: native.manifest.counts,
            pages,
            observations,
          },
          null,
          2,
        ),
      ),
  );
  for (let cycle = 0; cycle < 10; cycle++) {
    phase = `cycle ${cycle}: acquire`;
    await browser.click("#heap-open-a");
    await browser.poll(
      "document.querySelector('textarea[name=prompt]') && Number(document.querySelector('#heap-state').dataset.aCount)>=20",
    );
    if (cycle === 0) {
      await browser.fill("textarea[name=prompt]", "Unsent heap draft");
      await browser.click("#heap-choice");
    } else {assertEquals(
        await browser.evaluate(
          "document.querySelector('textarea[name=prompt]').value",
        ),
        "Unsent heap draft",
      );}
    await browser.click("#heap-load-all");
    await browser.poll(
      "document.querySelector('#heap-state').dataset.aCount==='1525' && document.querySelector('#heap-state').dataset.loading==='false'",
      120000,
    );
    await browser.poll(
      "document.querySelectorAll('.heap-view .otk-token').length>0",
      60000,
    );
    phase = `cycle ${cycle}: loaded page heap`;
    const loaded = messageHeapRetention(
      await captureMessageHeap(
        browser,
        join(heapDirectory, `page-loaded-${cycle}.heapsnapshot`),
      ),
      a.id,
      "Scale fixture 0/",
    );
    phase = `cycle ${cycle}: loaded worker heap`;
    const workerLoaded = messageHeapRetention(
      await captureMessageHeap(
        worker,
        join(heapDirectory, `worker-loaded-${cycle}.heapsnapshot`),
      ),
      a.id,
      "Scale fixture 0/",
    );
    console.info("Loaded scale heap measurement", {
      cycle,
      fixturePayloadBytes: PAYLOAD_BYTES,
      loaded,
      workerLoaded,
    });
    assert(loaded.messageRecords >= 1525, JSON.stringify(loaded));
    await browser.click("#heap-open-b");
    phase = `cycle ${cycle}: cool`;
    await browser.poll(
      "document.querySelectorAll('.heap-preview .otk-token').length>0 && document.querySelector('textarea[name=prompt]')",
    );
    await browser.click("#heap-cool");
    await browser.poll(
      "(()=>{const s=document.querySelector('#heap-state').dataset;return s.aCount==='0' && s.aReplies==='0' && s.aTemperature==='cold' && s.aSubscribed==='false' && s.aMetadata==='true' && s.choice==='true'})()",
    );
    await browser.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    phase = `cycle ${cycle}: cooled page heap`;
    const released = messageHeapRetention(
      await captureMessageHeap(
        browser,
        join(heapDirectory, `page-cooled-${cycle}.heapsnapshot`),
      ),
      a.id,
      "Scale fixture 0/",
    );
    phase = `cycle ${cycle}: cooled worker heap`;
    const workerReleased = messageHeapRetention(
      await captureMessageHeap(
        worker,
        join(heapDirectory, `worker-cooled-${cycle}.heapsnapshot`),
      ),
      a.id,
      "Scale fixture 0/",
    );
    const observation = {
      cycle,
      loaded,
      workerLoaded,
      released,
      workerReleased,
      paths: undefined as
        | Awaited<ReturnType<typeof measureSessionHeap>>
        | undefined,
    };
    observations.push(observation);
    const paths = await measureSessionHeap(browser, a.id, "Scale fixture 0/");
    observation.paths = paths;
    console.info("Cooled scale heap measurement", {
      cycle,
      released,
      workerReleased,
      sourcePaths: paths,
      releasedFraction: loaded.retainedBytes
        ? 1 - released.retainedBytes / loaded.retainedBytes
        : null,
    });
    const targets = await browser.send("Target.getTargets");
    assert(
      (targets.targetInfos as { targetId: string }[]).some((t) =>
        t.targetId === target.targetId
      ),
      "cooling cannot substitute worker termination for source release",
    );
    assertEquals(pages.filter((page) => !page.before).length, cycle + 1);
    assertEquals(browser.errors, []);
  }
});
