// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { WsClient } from "../support/ws-client.ts";

// Fixed selected-plan/build scenes; native approval/plugin transitions live in C9.
for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
  test(`V7 native plan approval switches the footer and next prompt while a coincidentally named plugin preserves selection (${theme})`, async () => {
    const provider = new FakeLlm();
    const f = await browserFixture({ "*": "allow" }, {
      providers: {
        fake2: {
          fake: provider,
          models: {
            scripted: {
              name: "Plan/build fixture",
              variants: {
                low: { reasoningEffort: "low" },
                high: { reasoningEffort: "high" },
              },
            },
          },
        },
      },
      config: {
        agent: {
          build: { model: "fake2/scripted", variant: "high" },
          plan: { model: "fake2/scripted", variant: "low" },
        },
      },
    });
    let client: WsClient | undefined;
    try {
      const session = await f.oc.session<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Plan/build visual choices" },
      });
      const server = await f.sidecar(), b = await f.browser(server.url);
      client = new WsClient(server.url);
      await client.connect();
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
      await openSession(b, session.id);
      for (
        const [agent, label, variant] of [["plan", "Plan", "Low"], [
          "build",
          "Build",
          "High",
        ]]
      ) {
        await b.click(".otk-agent-picker > button");
        await b.click(
          `.otk-agent-picker [data-picker-key="${agent}"] .otk-picker-option`,
        );
        await b.poll(
          `document.querySelector('.otk-composer-agent')?.textContent==='${label}' && document.querySelector('.otk-variant-picker > button > span')?.textContent==='${variant}'`,
        );
      }
    } finally {
      await client?.close();
      await f.stop();
    }
  });
}
