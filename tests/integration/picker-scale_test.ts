// SPDX-License-Identifier: LGPL-3.0-only
// Stock native catalog and real-browser row-admission proof. No paid inference.
import { assertEquals } from "@std/assert";
import {
  catalogReaders,
  discoverV2,
  V2Client,
} from "@otk/harness-opencode-v2-server";
import { modelGroups } from "@otk/client";
import { modelCatalogCodec } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { nativeKind } from "../support/native.ts";
import { withResources } from "../support/resources.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { readBuild, sourceTree } from "../../scripts/tests/prepare.ts";

Deno.test({
  name: "picker scale: stock V2 large catalog reads and mapping",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("inv-p-large-catalog", async () => {
      const providers = Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [
          i === 0 ? "fake" : `fixture-${i}`,
          {
            name: i === 0 ? "Default / OpenCode" : `Fixture provider ${i}`,
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: {
              baseURL: "http://127.0.0.1:1/v1",
              apiKey: "fixture-only",
            },
            models: Object.fromEntries(Array.from({ length: 100 }, (_, n) => [
              i === 0 && n === 0 ? "scripted" : `gpt-5.5-${n}`,
              { name: `GPT-5.5 fixture ${n}`, variants: [{ id: "high" }] },
            ])),
          },
        ]),
      );
      const started = performance.now();
      const native = await OpencodeV2Test.start(new FakeLlm(), {
        config: { providers },
      });
      const bootAndFixtureWarmMs = performance.now() - started;
      const calls: {
        path: string;
        started: number;
        ended?: number;
        bytes?: number;
      }[] = [];
      const service = await discoverV2(native.serviceFile);
      const controller = new AbortController();
      const client = new V2Client(
        service,
        30000,
        controller.signal,
        async (input, init) => {
          const call = {
            path: new URL(input instanceof Request ? input.url : String(input))
              .pathname,
            started: performance.now(),
          } as typeof calls[number];
          calls.push(call);
          const response = await fetch(input, init);
          const bytes = await response.arrayBuffer();
          call.bytes = bytes.byteLength;
          call.ended = performance.now();
          return new Response(bytes, {
            status: response.status,
            headers: response.headers,
          });
        },
      );
      try {
        const results = [];
        for (let run = 0; run < 3; run++) {
          const before = calls.length, start = performance.now();
          const catalog = await catalogReaders(() => client)["catalog.models"]!(
            { directory: native.directory },
            controller.signal,
          );
          const readMs = performance.now() - start;
          const groupStart = performance.now();
          const groups = modelGroups(catalog, [], []);
          const groupMs = performance.now() - groupStart;
          const chunkStart = performance.now(),
            builder = modelCatalogCodec.create();
          let chunks = 0;
          for (const chunk of modelCatalogCodec.chunks(catalog, 100)) {
            builder.append(chunk);
            chunks++;
          }
          assertEquals(builder.finish(), catalog);
          const roundTripMs = performance.now() - chunkStart;
          assertEquals(
            catalog.providers.filter((p) => p.id === "fake")[0].name,
            "Default / OpenCode",
          );
          const fixtureModels = catalog.providers.filter((p) =>
            p.id === "fake" || p.id.startsWith("fixture-")
          ).flatMap((p) => p.models);
          assertEquals(fixtureModels.length, 1600);
          const round = calls.slice(before);
          for (let i = 1; i < round.length; i++) {
            assertEquals(round[i].started >= round[i - 1].ended!, true);
          }
          results.push({
            run,
            readMs,
            groupMs,
            roundTripMs,
            chunks,
            providers: catalog.providers.length,
            models: catalog.providers.reduce((n, p) => n + p.models.length, 0),
            groups: groups.length,
            nativeReads: round.map((c) => ({
              path: c.path,
              ms: c.ended! - c.started,
              bytes: c.bytes,
            })),
          });
        }
        const evidence = {
          bootAndFixtureWarmMs,
          fixture:
            "16 configured providers x 100 models; native bundled catalog also retained",
          caveat:
            "OpencodeV2Test warms agents and models before returning; boot time includes that warm-up. Not the user's private provider set.",
          results,
        };
        console.log(JSON.stringify(evidence, null, 2));
        await Deno.writeTextFile(
          ".test-state/do/inv-p-native-measurement.json",
          JSON.stringify(evidence, null, 2),
        );
      } finally {
        controller.abort();
        await client.join();
      }
    }),
});

Deno.test({
  name:
    "picker scale: warmed 1610-model catalog stays bounded through open, search and navigation",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("inv-p-large-picker-reproduction", async () => {
      const build = await readBuild(await sourceTree());
      const previous = Deno.env.get("OTK_TEST_BINARY");
      Deno.env.set("OTK_TEST_BINARY", build.binary);
      try {
        const providers = Object.fromEntries(
          Array.from({ length: 16 }, (_, i) => [
            i === 0 ? "fake" : `fixture-${i}`,
            {
              name: i === 0 ? "Default / OpenCode" : `Fixture provider ${i}`,
              package: "aisdk:@ai-sdk/openai-compatible",
              settings: {
                baseURL: "http://127.0.0.1:1/v1",
                apiKey: "fixture-only",
              },
              models: Object.fromEntries(Array.from({ length: 100 }, (_, n) => [
                i === 0 && n === 0 ? "scripted" : `gpt-5.5-${n}`,
                { name: `GPT-5.5 fixture ${n}`, variants: [{ id: "high" }] },
              ])),
            },
          ]),
        );
        const native = await OpencodeV2Test.start(new FakeLlm(), {
          config: { providers },
        });
        const target = await native.createSession(
          "INV-P large picker reproduction",
        );
        const app = await SidecarTest.start(native);
        const script = `
        import { chromium } from "./tests/browser/node_modules/playwright/index.mjs";
        const browser = await chromium.launch({headless:true});
        try {
          const page = await browser.newPage({viewport:{width:1280,height:800}});
          page.setDefaultTimeout(90000);
          await page.goto(process.argv[1]);
          await page.waitForFunction(() => document.querySelector(".otk-composer-provider")?.textContent?.includes("Default / OpenCode"));
          console.log("Catalog ready before picker open");
           const start = performance.now();
           await page.locator(".otk-model-picker > button").click();
           const picker = page.locator(".otk-model-picker");
           const bounded = async () => {
             await page.waitForFunction(() => {
               const port = document.querySelector(".otk-model-picker [role=listbox]");
               const rows = [...port.querySelectorAll("[role=option]")];
               const minimum = Math.min(...rows.map(row => row.getBoundingClientRect().height));
               // Shared VirtualList's five-row overscan on each side, plus
               // committed/candidate pins. Headings consume space, never options.
               return rows.length > 0 && minimum > 0 && rows.length <= Math.ceil(port.clientHeight / minimum) + 10 + 2;
             });
             return picker.locator("[role=option]").count();
           };
           const opened = performance.now(), mounted = await bounded();
           const list = picker.locator("[role=listbox]");
           if (Number(await list.getAttribute("data-acquired-count")) !== 1627) throw Error("Complete 1610 models plus 17 headings required");
           const search = picker.locator("input[type=search]");
           const committed = await picker.locator("[aria-selected=true]").getAttribute("data-picker-key");
           const active = async () => {
             const id = await search.getAttribute("aria-activedescendant");
             const row = page.locator('[id=' + JSON.stringify(id) + ']');
             await row.waitFor({state:"visible"});
             return row.getAttribute("data-picker-key");
           };
           await search.press("End");
           const last = await active();
           await bounded();
           if (await picker.locator("[aria-selected=true]").getAttribute("data-picker-key") !== committed) throw Error("Navigation changed committed selection");
           await search.press("Home");
           if (await active() === last) throw Error("Home/End did not traverse complete catalog");
           const beforeSearch = performance.now();
           await search.fill("5.5 fixture 99");
           await page.waitForFunction(() => document.querySelector(".otk-model-picker [role=listbox]")?.getAttribute("data-acquired-count") === "32");
           const found = new Set();
           await search.press("Home");
           for (let i = 0; i < 16; i++) {
             found.add(await active());
             await search.press("ArrowDown");
           }
           if (found.size !== 16) throw Error("All 16 provider matches must be reachable");
           const searched = performance.now(), searchedMounted = await bounded();
           await search.press("Enter");
           await page.waitForFunction(() => !document.querySelector(".otk-model-picker input[type=search]"));
           console.log(JSON.stringify({models:1610,mounted,searchMatches:found.size,searchedMounted,openMs:opened-start,searchAndTraversalMs:searched-beforeSearch}));
        } finally {await browser.close();}
      `;
        const result = await new Deno.Command("node", {
          args: [
            "--input-type=module",
            "-e",
            script,
            `${app.url}/#/local/${target.id}`,
          ],
          stdout: "inherit",
          stderr: "inherit",
          signal: AbortSignal.timeout(180000),
        }).output();
        assertEquals(
          result.code,
          0,
          "The warmed native catalog must remain usable through picker open and search",
        );
      } finally {
        if (previous === undefined) Deno.env.delete("OTK_TEST_BINARY");
        else Deno.env.set("OTK_TEST_BINARY", previous);
      }
    }),
});
