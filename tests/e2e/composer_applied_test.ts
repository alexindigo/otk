// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { PromptInput } from "@otk/protocol";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { WsClient } from "../support/ws-client.ts";
import { selectionGeometry } from "../support/selection-geometry.ts";

const trigger = ".otk-variant-picker > button";
const row = (key: string) =>
  `.otk-variant-picker [data-picker-key=${JSON.stringify(key)}]`;

test("P6 Default shows the muted backend-applied variant at the native consumer; explicit and restored choices are unmuted", async () => {
  const fake2 = new FakeLlm();
  const f = await browserFixture({}, {
    providers: {
      fake2: {
        fake: fake2,
        name: "Second fixture provider",
        models: {
          scripted: {
            name: "Scripted with variants",
            variants: {
              low: { reasoningEffort: "low" },
              high: { reasoningEffort: "high" },
            },
          },
        },
      },
    },
    config: {
      default_agent: "reviewer",
      agent: {
        reviewer: {
          mode: "primary",
          model: "fake2/scripted",
          variant: "high",
          color: "#12abEF",
        },
      },
    },
  });
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Backend-applied composer choices" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await openSession(b, session.id);
    await b.poll(
      `document.querySelector('${trigger}')?.getAttribute('aria-label')==='Variant: High (agent default)'`,
    );
    for (
      const [kind, name] of [["agent", "Reviewer (agent default)"], [
        "model",
        "Second fixture provider Scripted with variants (agent default)",
      ], ["variant", "High (agent default)"]]
    ) {
      const button = `.otk-${kind}-picker > button`;
      assertEquals(
        await b.evaluate(
          `document.querySelector('${button}').classList.contains('is-applied')`,
        ),
        true,
      );
      assertEquals(
        await b.evaluate(
          `document.querySelector('${button}').getAttribute('aria-label')`,
        ),
        `${kind[0].toUpperCase()}${kind.slice(1)}: ${name}`,
      );
    }
    const pick = async (key: string) => {
      await b.click(trigger);
      await b.poll(
        "!!document.querySelector('.otk-variant-picker .otk-popover-panel:popover-open')",
      );
      await b.click(`${row(key)} .otk-picker-option`);
      await b.poll(
        "document.activeElement?.name==='prompt' && !document.querySelector('.otk-popover-panel:popover-open')",
      );
    };
    const measure = () =>
      b.evaluate<
        {
          rects: unknown[];
          color: string;
          muted: string;
          font: string;
          text: string;
          centres: number[];
        }
      >(`(()=>{const buttons=[...document.querySelectorAll('.otk-prompt-actions > button, .otk-prompt-context > .otk-popover > button')],t=document.querySelector('${trigger}'),s=getComputedStyle(t),probe=document.createElement('span');probe.style.color='var(--applied-fg)';document.body.append(probe);const muted=getComputedStyle(probe).color;probe.remove();return {rects:buttons.map(el=>el.getBoundingClientRect().toJSON()),centres:buttons.map(el=>{const r=el.getBoundingClientRect();return r.y+r.height/2}),color:s.color,muted,font:s.font,text:t.textContent}})()`);
    const shots = Deno.env.get("OTK_APPLIED_SHOTS");
    if (shots) await Deno.mkdir(shots, { recursive: true });
    const modelLabel = async (applied: boolean) => {
      const model = await b.evaluate<{
        provider: string;
        name: string;
        applied: boolean;
        providerMuted: boolean;
        modelMuted: boolean;
        gap: number;
        centre: number;
      }>(
        `(()=>{const t=document.querySelector('.otk-model-picker > button'),p=t.querySelector('.otk-composer-provider'),m=t.querySelector('.otk-composer-model-name'),a=p.getBoundingClientRect(),r=m.getBoundingClientRect(),probe=document.createElement('span');probe.style.color='var(--applied-fg)';document.body.append(probe);const muted=getComputedStyle(probe).color;probe.remove();return {provider:p.textContent,name:m.textContent,applied:t.classList.contains('is-applied'),providerMuted:getComputedStyle(p).color===muted,modelMuted:getComputedStyle(m).color===muted,gap:r.left-a.right,centre:Math.abs(a.y+a.height/2-r.y-r.height/2)}})()`,
      );
      assertEquals(model.provider, "Second fixture provider");
      assertEquals(model.name, "Scripted with variants");
      assertEquals(model.applied, applied);
      assertEquals(model.providerMuted, true);
      assertEquals(model.modelMuted, applied);
      assertEquals(model.gap, 8);
      assert(model.centre < .5, JSON.stringify(model));
    };
    for (
      const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
    ) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(
        `document.documentElement.dataset.otkTheme===${JSON.stringify(theme)}`,
      );
      await modelLabel(true);
      await pick("high");
      await b.poll(
        `document.querySelector('${trigger}').getAttribute('aria-label')==='Variant: High' && !document.querySelector('${trigger}').classList.contains('is-applied')`,
      );
      const explicit = await measure();
      if (shots) await b.screenshot(join(shots, `p6-explicit-${name}.png`));
      await pick("");
      await b.poll(
        `document.querySelector('${trigger}').getAttribute('aria-label')==='Variant: High (agent default)' && document.querySelector('${trigger}').classList.contains('is-applied')`,
      );
      const muted = await measure();
      assertEquals(
        muted.rects,
        explicit.rects,
        "Applied state changes paint, not footer geometry",
      );
      assertEquals(muted.text, explicit.text);
      assertEquals(muted.font, explicit.font);
      assert(
        muted.color !== explicit.color,
        JSON.stringify({ explicit, muted }),
      );
      assertEquals(muted.color, muted.muted);
      assertEquals(muted.centres.length, 6);
      assert(Math.max(...muted.centres) - Math.min(...muted.centres) < .5);
      if (shots) await b.screenshot(join(shots, `p6-muted-${name}.png`));
      await b.click(trigger);
      await b.poll(
        `document.querySelector(${
          JSON.stringify(row(""))
        })?.getAttribute('aria-selected')==='true'`,
      );
      assertEquals(
        await b.evaluate(
          `document.querySelector(${
            JSON.stringify(row(""))
          }).querySelector('small')?.textContent`,
        ),
        "High",
      );
      assertEquals(
        await b.evaluate(
          `document.querySelector(${
            JSON.stringify(row("high"))
          }).getAttribute('aria-selected')`,
        ),
        "false",
      );
      const pointer = await selectionGeometry(b, row(""));
      assertEquals(pointer.length, 1);
      assertEquals([pointer[0].w, pointer[0].h, pointer[0].selected], [
        3,
        14,
        true,
      ]);
      assert(pointer[0].centred < .5);
      if (shots) await b.screenshot(join(shots, `p6-default-row-${name}.png`));
      await b.key("Escape");
    }
    // Explicit Default omits the variant at the wire. Stock opencode applies high.
    fake2.queue({ chunks: ["Applied high arrived."] });
    await b.type("textarea[name=prompt]", "P6-DEFAULT");
    await b.key("Enter");
    await waitForReply(b, session.id, "Applied high arrived.");
    const sent = sentFrames(b).findLast(({ frame }) =>
      frame.method === "session.prompt"
    )!.frame.params as PromptInput;
    assertEquals(Object.hasOwn(sent, "variant"), false);
    assertEquals(sent.model, { provider: "fake2", model: "scripted" });
    assertEquals(sent.agent, "reviewer");
    const nativeUsers = async () =>
      (await f.oc.request<
        { info: { role: string; model?: unknown; agent?: string } }[]
      >(`/session/${session.id}/message`)).filter((row) =>
        row.info.role === "user"
      );
    assertEquals((await nativeUsers())[0].info.model, {
      providerID: "fake2",
      modelID: "scripted",
      variant: "high",
    });
    assert(
      fake2.requests.some((request) =>
        JSON.stringify(request.messages).includes("P6-DEFAULT") &&
        request.reasoning_effort === "high"
      ),
    );
    await b.poll(
      `document.querySelector('${trigger}').classList.contains('is-applied')`,
    );
    // A reload restores the user's recorded choice, so it is stable and unmuted.
    await b.reload();
    await b.poll(
      `document.querySelector('${trigger}')?.getAttribute('aria-label')==='Variant: High' && !document.querySelector('${trigger}').classList.contains('is-applied')`,
    );
    for (const kind of ["agent", "model"]) {
      assertEquals(
        await b.evaluate(
          `document.querySelector('.otk-${kind}-picker > button').classList.contains('is-applied')`,
        ),
        false,
      );
    }
    for (
      const [name, theme] of [["dark", "otk-dark"], ["light", "otk-light"]]
    ) {
      await client.rpc("prefs.set", { key: "theme", value: theme });
      await b.poll(
        `document.documentElement.dataset.otkTheme===${JSON.stringify(theme)}`,
      );
      await modelLabel(false);
      if (shots) await b.screenshot(join(shots, `p6-restored-${name}.png`));
    }
    await pick("low");
    await b.poll(
      `document.querySelector('${trigger}').getAttribute('aria-label')==='Variant: Low' && !document.querySelector('${trigger}').classList.contains('is-applied')`,
    );
    fake2.queue({ chunks: ["Explicit low arrived."] });
    await b.type("textarea[name=prompt]", "P6-EXPLICIT");
    await b.key("Enter");
    await waitForReply(b, session.id, "Explicit low arrived.");
    assertEquals(
      (sentFrames(b).findLast(({ frame }) => frame.method === "session.prompt")!
        .frame.params as PromptInput).variant,
      "low",
    );
    assertEquals((await nativeUsers())[1].info.model, {
      providerID: "fake2",
      modelID: "scripted",
      variant: "low",
    });
    assert(
      fake2.requests.some((request) =>
        JSON.stringify(request.messages).includes("P6-EXPLICIT") &&
        request.reasoning_effort === "low"
      ),
    );
    assertEquals(f.fake.requests.length, 0);
  } finally {
    await client?.close();
    await f.stop();
  }
});
