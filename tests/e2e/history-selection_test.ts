// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";

for (const variant of ["high", undefined]) {
  test(`history recall retains chosen model and ${variant ?? "explicit Default"} through editor, send and native receipt`, async () => {
    const provider = new FakeLlm();
    const f = await browserFixture({}, {
      providers: {
        selected: {
          fake: provider,
          name: "Chosen provider",
          models: {
            chosen: {
              name: "Chosen model",
              variants: { high: { reasoningEffort: "high" } },
            },
          },
        },
      },
    });
    let client: WsClient | undefined;
    try {
      const source = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "History source" },
      });
      const target = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Recall with choices" },
      });
      // Default needs a restored High positive control; High uses another model
      // so dropping the explicit model is observable independently.
      await f.oc.request(`/session/${target.id}/message`, {
        method: "POST",
        body: {
          noReply: true,
          model: variant === undefined
            ? { providerID: "selected", modelID: "chosen" }
            : { providerID: "fake", modelID: "scripted" },
          variant: "high",
          parts: [{ type: "text", text: "context before recall" }],
        },
      });
      await f.oc.request(`/session/${source.id}/message`, {
        method: "POST",
        body: {
          noReply: true,
          parts: [{ type: "text", text: "recalled history content" }],
        },
      });
      const server = await f.sidecar(), b = await f.browser(server.url);
      client = new WsClient(server.url);
      await client.connect();
      await openSession(b, target.id);
      await b.click(".otk-model-picker > button");
      const chosen = `.otk-model-picker .otk-picker-row[data-picker-key='${
        JSON.stringify(["selected", "chosen"])
      }']`;
      await b.poll(`!!document.querySelector(${JSON.stringify(chosen)})`);
      await b.click(chosen);
      await b.click(".otk-variant-picker > button");
      await b.click(
        `.otk-variant-picker .otk-picker-row[data-picker-key="${
          variant ?? ""
        }"]`,
      );
      await b.poll("document.activeElement?.name==='prompt'");
      await b.key("ArrowUp");
      await b.poll(
        "document.querySelector('textarea[name=prompt]').value==='recalled history content'",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-composer-model-name').textContent",
        ),
        "Chosen model",
        "History replaced the chosen model",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-variant-picker > button > span').textContent",
        ),
        variant ? "High" : "Default",
        "History replaced explicit variant ownership",
      );
      await b.click('[aria-label="Edit prompt"]');
      await b.poll("!!document.querySelector('dialog[open] textarea')");
      await b.fill("dialog[open] textarea", "edited recalled history content");
      await b.click("dialog[open] .otk-editor footer button:last-child");
      await b.poll(
        "!document.querySelector('dialog[open]') && document.querySelector('textarea[name=prompt]').value==='edited recalled history content'",
      );
      const shots = Deno.env.get("OTK_HISTORY_SHOTS");
      if (shots) {
        await Deno.mkdir(shots, { recursive: true });
        for (
          const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
        ) {
          await client.rpc("prefs.set", { key: "theme", value: theme });
          await b.poll(
            `document.documentElement.dataset.otkTheme===${
              JSON.stringify(theme)
            }`,
          );
          await b.screenshot(
            join(shots, `history-${variant ?? "default"}-${name}.png`),
          );
        }
      }
      provider.queue({ chunks: ["Reply from chosen history model"] });
      await b.click(".otk-prompt button[type=submit]");
      await waitForReply(b, target.id, "Reply from chosen history model");
      const frame = sentFrames(b).filter(({ frame }) =>
        frame.method === "session.prompt"
      ).at(-1)!.frame;
      assert(frame.params !== null && typeof frame.params === "object");
      assertEquals(Reflect.get(frame.params, "model"), {
        provider: "selected",
        model: "chosen",
      });
      assertEquals(Reflect.get(frame.params, "variant"), variant);
      const rows = await waitFor(
        () =>
          f.oc.request<
            {
              info: {
                role: string;
                model?: {
                  providerID: string;
                  modelID: string;
                  variant?: string;
                };
              };
              parts: { text?: string }[];
            }[]
          >(`/session/${target.id}/message`),
        (rows) =>
          rows.some((row) =>
            row.info.role === "user" &&
            row.parts.some((part) =>
              part.text === "edited recalled history content"
            )
          ),
      );
      assertEquals(
        rows.find((row) =>
          row.info.role === "user" &&
          row.parts.some((part) =>
            part.text === "edited recalled history content"
          )
        )!.info.model,
        {
          providerID: "selected",
          modelID: "chosen",
          ...(variant ? { variant } : {}),
        },
      );
      assertEquals(
        provider.requests.some((request) =>
          JSON.stringify(request).includes("edited recalled history content")
        ),
        true,
      );
    } finally {
      await client?.close();
      await f.stop();
      await provider.stop();
    }
  });
}
