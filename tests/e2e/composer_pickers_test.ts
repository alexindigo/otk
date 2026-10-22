// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ModelCatalog, Preferences, PromptInput } from "@otk/protocol";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";
import type { Cdp } from "../support/cdp.ts";
import { Cdp as Browser } from "../support/cdp.ts";
import { selectionGeometry } from "../support/selection-geometry.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { mapMessage, Opencode1Adapter } from "@otk/harness-opencode1";
import { cfg } from "../support/config.ts";

const input = "textarea[name=prompt]";
const modelSearch = ".otk-model-picker input[type=search]";
const option = (label: string) =>
  `.otk-picker-row[data-picker-key=${JSON.stringify(label)}]`;
const modelOption = (model: string) =>
  `.otk-model-picker ${option(JSON.stringify(["fake2", model]))}`;
const open = async (b: Cdp, kind: string) => {
  const before = await b.evaluate(
    "document.querySelector('.otk-prompt').getBoundingClientRect().toJSON()",
  );
  await b.click(`.otk-${kind}-picker > button`);
  await b.poll(
    `!!document.querySelector('.otk-${kind}-picker .otk-popover-panel:popover-open')`,
  );
  await b.poll(
    `document.querySelector('.otk-${kind}-picker .otk-popover-panel')?.contains(document.activeElement)`,
  );
  const after = await b.evaluate(
    "document.querySelector('.otk-prompt').getBoundingClientRect().toJSON()",
  );
  const geometry = await b.evaluate<
    { panel: DOMRect; trigger: DOMRect; viewport: [number, number] }
  >(
    `(()=>{const p=document.querySelector('.otk-${kind}-picker .otk-popover-panel'),s=getComputedStyle(p),t=document.querySelector('.otk-${kind}-picker > button');return {panel:p.querySelector('.otk-surface').getBoundingClientRect().toJSON(),position:s.position,area:s.positionArea,anchor:s.positionAnchor,trigger:t.getBoundingClientRect().toJSON(),anchorName:getComputedStyle(t).anchorName,scrollHeight:document.documentElement.scrollHeight,clientHeight:document.documentElement.clientHeight,scrollY,viewport:[innerWidth,innerHeight]}})()`,
  );
  assertEquals(
    after,
    before,
    `Opening ${kind} must not scroll or move the composer: ${
      JSON.stringify(geometry)
    }`,
  );
  assert(
    geometry.panel.bottom <= geometry.trigger.top + .5,
    "Footer popover must open above its trigger",
  );
  assert(
    geometry.panel.left >= 0 && geometry.panel.right <= geometry.viewport[0],
    "Popover must remain within the viewport",
  );
  const leadingFits =
    geometry.trigger.left + geometry.panel.width <= geometry.viewport[0];
  assert(
    Math.abs(
      leadingFits
        ? geometry.panel.left - geometry.trigger.left
        : geometry.panel.right - geometry.trigger.right,
    ) < .5,
    "Popover aligns to the leading edge, or trailing edge only for overflow",
  );
};
async function footerGeometry(b: Cdp) {
  const centres = await b.evaluate<number[]>(
    `[...document.querySelectorAll('.otk-prompt-actions > button, .otk-prompt-context > .otk-popover > button')].map(el=>{const r=el.getBoundingClientRect();return r.y+r.height/2})`,
  );
  // Three settings plus the existing Attach, Edit and Send controls.
  assertEquals(centres.length, 6);
  assert(
    Math.max(...centres) - Math.min(...centres) < .5,
    JSON.stringify(centres),
  );
  const chevrons = await b.evaluate<{ delta: number; label: string }[]>(
    `[...document.querySelectorAll('.otk-prompt-context > .otk-popover > button')].map(button=>{const label=button.querySelector('span'),icon=button.querySelector('svg'),a=label.getBoundingClientRect(),b=icon.getBoundingClientRect();return {delta:Math.abs(a.y+a.height/2-b.y-b.height/2),label:button.getAttribute('aria-label')}})`,
  );
  assertEquals(chevrons.length, 3);
  assert(chevrons.every((item) => item.delta < .5), JSON.stringify(chevrons));
  assertEquals(chevrons.map((item) => item.label), [
    "Agent: Reviewer",
    "Model: Second fixture provider Scripted with variants",
    "Variant: High",
  ]);
  const model = await b.evaluate<{
    provider: string;
    name: string;
    gap: number;
    centre: number;
    width: number;
    providerFull: boolean;
    modelFull: boolean;
    muted: boolean;
    foreground: boolean;
  }>(
    `(()=>{const t=document.querySelector('.otk-model-picker > button'),p=t.querySelector('.otk-composer-provider'),m=t.querySelector('.otk-composer-model-name'),label=t.querySelector('.otk-composer-model'),a=p.getBoundingClientRect(),b=m.getBoundingClientRect(),probe=document.createElement('span');probe.style.color='var(--otk-fg-2)';document.body.append(probe);const muted=getComputedStyle(p).color===getComputedStyle(probe).color;probe.remove();return {provider:p.textContent,name:m.textContent,gap:b.left-a.right,centre:Math.abs(a.y+a.height/2-b.y-b.height/2),width:label.getBoundingClientRect().width,providerFull:p.scrollWidth<=p.clientWidth,modelFull:m.scrollWidth<=m.clientWidth,muted,foreground:getComputedStyle(m).color===getComputedStyle(t).color}})()`,
  );
  assertEquals(model.provider, "Second fixture provider");
  assertEquals(model.name, "Scripted with variants");
  assertEquals(model.gap, 8);
  assert(
    model.centre < .5 && model.providerFull && model.modelFull && model.muted &&
      model.foreground,
    JSON.stringify(model),
  );
}

async function footerPressure(b: Cdp, shots?: string, theme = "dark") {
  try {
    for (
      const [width, state] of [[1180, "provider"], [1060, "model"]] as const
    ) {
      await b.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 657,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await b.poll(`innerWidth===${width}`);
      const geometry = await b.evaluate<{
        providerTruncated: boolean;
        modelTruncated: boolean;
        centres: number[];
        inside: boolean;
        overflow: boolean;
      }>(
        `(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const footer=document.querySelector('.otk-prompt-actions'),r=footer.getBoundingClientRect(),p=document.querySelector('.otk-composer-provider'),m=document.querySelector('.otk-composer-model-name'),buttons=[...footer.querySelectorAll(':scope > button,.otk-prompt-context > .otk-popover > button')],rects=buttons.map(el=>el.getBoundingClientRect());return {providerTruncated:p.scrollWidth>p.clientWidth,modelTruncated:m.scrollWidth>m.clientWidth,centres:rects.map(b=>b.y+b.height/2),inside:rects.every(b=>b.left>=r.left-.5&&b.right<=r.right+.5),overflow:footer.scrollWidth>footer.clientWidth}})()`,
      );
      assertEquals(
        geometry.providerTruncated,
        true,
        JSON.stringify({ width, geometry }),
      );
      assertEquals(
        geometry.modelTruncated,
        state === "model",
        JSON.stringify({ width, geometry }),
      );
      assertEquals(geometry.centres.length, 6);
      assert(
        Math.max(...geometry.centres) - Math.min(...geometry.centres) < .5 &&
          geometry.inside && !geometry.overflow,
        JSON.stringify({ width, geometry }),
      );
      if (shots) {
        await b.screenshot(join(shots, `P4-r2-${theme}-pressure-${state}.png`));
      }
    }
  } finally {
    await b.send("Emulation.clearDeviceMetricsOverride");
    await b.poll("innerWidth===1280");
  }
}

async function actionGeometry(b: Cdp) {
  const measured = await b.evaluate<
    {
      inside: boolean;
      sharedBox: boolean;
      centre: number;
      icon: number;
      sharedIcon: number;
    }
  >(`(()=>{const row=document.querySelector(${
    JSON.stringify(modelOption("scripted"))
  }),action=row.querySelector('.otk-picker-action'),icon=action.querySelector('svg'),r=row.getBoundingClientRect(),a=action.getBoundingClientRect();return {inside:a.left>=r.left&&a.right<=r.right&&a.top>=r.top&&a.bottom<=r.bottom,sharedBox:action.closest('[data-otk-selection]')===row,centre:Math.abs(a.y+a.height/2-r.y-r.height/2),icon:icon.getBoundingClientRect().width,sharedIcon:document.querySelector('.otk-send-button svg').getBoundingClientRect().width}})()`);
  assert(
    measured.inside && measured.sharedBox && measured.centre < .5,
    JSON.stringify(measured),
  );
  assertEquals(measured.icon, measured.sharedIcon);
}
async function pointer(b: Cdp, selector: string) {
  await b.poll(
    "!document.querySelector('.otk-popover-panel:popover-open [role=status]')",
  );
  const rows = await selectionGeometry(b, selector);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].selected, true);
  assertEquals(rows[0].ariaSelected, "true");
  assertEquals([rows[0].w, rows[0].h, rows[0].start, rows[0].shift], [
    3,
    14,
    3,
    0,
  ]);
  assert(rows[0].centred < .5, JSON.stringify(rows));
  assert(
    await b.evaluate(
      `(()=>{const el=document.querySelector(${
        JSON.stringify(selector)
      }),r=el.getBoundingClientRect(),list=el.closest('.otk-picker-groups').getBoundingClientRect();return r.top>=list.top-.5&&r.bottom<=list.bottom+.5&&r.top>=0&&r.bottom<=innerHeight})()`,
    ),
    "Current row must be visible in the picker scroll region",
  );
}

Deno.test("V5 composer picks reach native messages and the selected provider; restore, favourites, keyboard, slash and shell keep the same selection", async () => {
  const fake2 = new FakeLlm();
  const f = await browserFixture({ bash: "allow" }, {
    providers: {
      fake2: {
        fake: fake2,
        name: "Second fixture provider",
        models: {
          scripted: {
            name: "Scripted with variants",
            release_date: "2026-10-17",
            variants: {
              low: { reasoningEffort: "low" },
              high: { reasoningEffort: "high" },
            },
          },
          plain: { name: "Plain model", release_date: "2026-10-16" },
        },
      },
    },
    config: {
      agent: {
        reviewer: {
          mode: "primary",
          description: "Review changes",
          color: "#12abEF",
        },
      },
    },
    async prepare(oc) {
      await Deno.mkdir(join(oc.directory, ".opencode/command"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(oc.directory, ".opencode/command/probe.md"),
        "---\ndescription: Picker selection probe\n---\nPICKER-COMMAND $ARGUMENTS",
      );
    },
  });
  let client: WsClient | undefined;
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Composer pickers" },
    });
    const other = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Other session" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await openSession(b, session.id);
    assertEquals(
      await b.evaluate(
        "document.querySelectorAll('.otk-prompt-context .otk-picker-groups').length",
      ),
      0,
      "Closed pickers mount no catalog DOM",
    );
    await open(b, "agent");
    await b.poll(
      `!!document.querySelector('.otk-agent-picker ${option("reviewer")}')`,
    );
    assertEquals(
      await b.evaluate(
        `document.querySelector('.otk-agent-picker ${
          option("reviewer")
        } .otk-picker-name > span').textContent`,
      ),
      "Reviewer",
    );
    await b.click(`.otk-agent-picker ${option("reviewer")}`);
    await b.poll(
      "document.querySelector('.otk-composer-agent')?.textContent==='Reviewer' && document.activeElement?.name==='prompt'",
    );
    assertEquals(
      await b.evaluate(
        "getComputedStyle(document.querySelector('.otk-composer-agent')).color",
      ),
      "rgb(18, 171, 239)",
    );
    await b.key("'", 2);
    await b.poll(
      `document.activeElement===document.querySelector('${modelSearch}')`,
    );
    await b.send("Input.insertText", { text: "Scripted with variants" });
    await b.poll(
      `document.querySelectorAll('.otk-model-picker .otk-picker-option').length===1 && !!document.querySelector(${
        JSON.stringify(modelOption("scripted"))
      })`,
    );
    await b.key("Enter");
    await b.poll(
      "document.activeElement?.name==='prompt' && !!document.querySelector('.otk-variant-picker')",
    );
    await open(b, "variant");
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('.otk-variant-picker .otk-picker-name > span')].map(el=>el.textContent)",
      ),
      ["Default", "Low", "High"],
    );
    await b.click(`.otk-variant-picker ${option("high")}`);
    await b.poll(
      "document.querySelector('.otk-variant-picker > button > span')?.textContent==='High' && document.activeElement?.name==='prompt'",
    );
    await open(b, "variant");
    await b.key("Home");
    await b.poll(
      `document.querySelector('.otk-variant-picker ${
        option("")
      }')?.classList.contains('is-highlighted')`,
    );
    await pointer(b, `.otk-variant-picker ${option("high")}`);
    await b.key("Enter");
    await b.poll(
      "document.querySelector('.otk-variant-picker > button > span')?.textContent==='Default'",
    );
    await open(b, "variant");
    await b.key("End");
    await b.key("ArrowUp");
    await b.key("ArrowDown");
    await b.poll(
      `document.querySelector('.otk-variant-picker ${
        option("high")
      }')?.classList.contains('is-highlighted')`,
    );
    await b.key("Home");
    await b.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowDown",
      code: "ArrowDown",
      windowsVirtualKeyCode: 40,
      autoRepeat: false,
    });
    await b.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowDown",
      code: "ArrowDown",
      windowsVirtualKeyCode: 40,
      autoRepeat: true,
    });
    await b.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "ArrowDown",
      code: "ArrowDown",
      windowsVirtualKeyCode: 40,
    });
    await b.poll(
      `document.querySelector('.otk-variant-picker ${
        option("high")
      }')?.classList.contains('is-highlighted')`,
    );
    await b.key("Enter");
    await b.poll(
      "document.querySelector('.otk-variant-picker > button > span')?.textContent==='High' && document.activeElement?.name==='prompt'",
    );
    await footerGeometry(b);
    await footerPressure(b);

    const shots = Deno.env.get("OTK_PICKER_SHOTS");
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
        await footerGeometry(b);
        await b.screenshot(join(shots, `P4-r2-${name}-footer.png`));
        await footerPressure(b, shots, name);
        await open(b, "agent");
        await pointer(b, `.otk-agent-picker ${option("reviewer")}`);
        await b.screenshot(join(shots, `P4-r2-${name}-agent.png`));
        await b.key("Escape");
        await open(b, "model");
        await pointer(b, modelOption("scripted"));
        await actionGeometry(b);
        assertEquals(
          await b.evaluate(
            "[...document.querySelectorAll('.otk-model-picker section')].filter(section=>!['Favourites','Recent'].includes(section.querySelector('h3')?.textContent)).flatMap(section=>[...section.querySelectorAll('.otk-picker-name small')]).length",
          ),
          0,
          "Provider groups do not repeat their provider subtitle",
        );
        await b.screenshot(join(shots, `P4-r2-${name}-model.png`));
        await b.fill(modelSearch, "Scripted with variants");
        await b.screenshot(join(shots, `P4-r2-${name}-search.png`));
        if (name === "dark") {
          await b.click(
            '[aria-label="Add Scripted with variants to favourites"]',
          );
        }
        await b.poll(
          "[...document.querySelectorAll('.otk-model-picker h3')].some(el=>el.textContent==='Favourites')",
        );
        await actionGeometry(b);
        assertEquals(
          await b.evaluate(
            "document.querySelector('.otk-model-picker .otk-picker-name small')?.textContent",
          ),
          "Second fixture provider",
        );
        await b.screenshot(join(shots, `P4-r2-${name}-favourite.png`));
        await b.key("Escape");
        await open(b, "variant");
        await pointer(b, `.otk-variant-picker ${option("high")}`);
        await b.screenshot(join(shots, `P4-r2-${name}-variant.png`));
        await b.key("Escape");
      }
    } else {
      await open(b, "model");
      await b.fill(modelSearch, "Scripted with variants");
      await b.click('[aria-label="Add Scripted with variants to favourites"]');
      await b.poll(
        "[...document.querySelectorAll('.otk-model-picker h3')].some(el=>el.textContent==='Favourites')",
      );
      await pointer(b, modelOption("scripted"));
      await actionGeometry(b);
      await b.key("Escape");
    }
    await b.poll(
      "document.querySelectorAll('.otk-prompt-context .otk-picker-groups').length===0",
    );
    fake2.queue({ chunks: ["Selected provider replied."] });
    await b.type(input, "PICKER-NORMAL selected model");
    await b.key("Enter");
    await waitForReply(b, session.id, "Selected provider replied.");
    const selected = {
      agent: "reviewer",
      model: { provider: "fake2", model: "scripted" },
      variant: "high",
    };
    const normal = sentFrames(b).find(({ frame }) =>
      frame.method === "session.prompt"
    )!.frame.params as PromptInput;
    assertEquals({
      agent: normal.agent,
      model: normal.model,
      variant: normal.variant,
    }, selected);
    const native = await f.oc.request<
      { info: { role: string; agent?: string; model?: unknown } }[]
    >(`/session/${session.id}/message`);
    const user = native.find((row) => row.info.role === "user")!;
    assertEquals(user.info.agent, "reviewer");
    assertEquals(user.info.model, {
      providerID: "fake2",
      modelID: "scripted",
      variant: "high",
    });
    assertEquals(f.fake.requests.length, 0);
    assert(
      fake2.requests.some((request) =>
        JSON.stringify(request.messages).includes("PICKER-NORMAL") &&
        request.model === "scripted" && request.reasoning_effort === "high"
      ),
    );
    const persisted = await waitFor(
      () => client!.rpc<Preferences>("prefs.get", {}),
      (prefs) => prefs["models.recent"][0]?.provider === "fake2",
    );
    assertEquals(persisted["models.recent"][0], selected.model);
    await b.reload();
    await b.poll(
      "document.querySelector('.otk-composer-agent')?.textContent==='Reviewer' && document.querySelector('.otk-variant-picker > button > span')?.textContent==='High'",
    );
    await openSession(b, other.id);
    await openSession(b, session.id);
    await b.poll(
      "document.querySelector('.otk-model-picker .otk-composer-model-name')?.textContent==='Scripted with variants' && document.querySelector('.otk-variant-picker > button > span')?.textContent==='High'",
    );
    await open(b, "model");
    await b.poll(
      "document.querySelector('.otk-model-picker section:first-child h3')?.textContent==='Favourites' && !!document.querySelector('[aria-label=\"Remove Scripted with variants from favourites\"]')",
    );
    await b.poll("!document.querySelector('.otk-model-picker [role=status]')");
    const before = sentFrames(b).filter(({ frame }) =>
      frame.method === "models.list"
    ).length;
    await b.key("Escape");
    await open(b, "model");
    await waitFor(
      () =>
        sentFrames(b).filter(({ frame }) => frame.method === "models.list")
          .length,
      (count) => count > before,
    );
    // Highlight is not selection: moving to the last row preserves the pointer.
    await b.fill(modelSearch, "Second fixture provider");
    await b.key("End");
    await pointer(b, modelOption("scripted"));
    await b.key("Escape");
    await b.type(input, "/probe chosen");
    fake2.queue({ chunks: ["Slash selection replied."] });
    await b.key("Enter");
    await waitForReply(b, session.id, "Slash selection replied.");
    const command = sentFrames(b).findLast(({ frame }) =>
      frame.method === "session.command"
    )!.frame.params as PromptInput;
    assertEquals({
      agent: command.agent,
      model: command.model,
      variant: command.variant,
    }, selected);
    assert(
      fake2.requests.some((request) =>
        JSON.stringify(request.messages).includes("PICKER-COMMAND chosen") &&
        request.reasoning_effort === "high"
      ),
    );
    await b.click(input);
    await b.key("!");
    await b.poll(
      "document.querySelector('.otk-prompt > label')?.textContent==='Shell' && !document.querySelector('.otk-variant-picker')",
    );
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('.otk-prompt-context > .otk-popover > button')].map(el=>el.getAttribute('aria-label'))",
      ),
      [
        "Agent: Reviewer",
        "Model: Second fixture provider Scripted with variants",
      ],
    );
    await b.send("Input.insertText", { text: "echo PICKER-SHELL" });
    await b.key("Enter");
    await b.poll(
      "[...document.querySelectorAll('[data-tool=bash]')].some(el=>el.dataset.toolStatus==='completed'&&el.textContent.includes('PICKER-SHELL'))",
    );
    const shell = sentFrames(b).findLast(({ frame }) =>
      frame.method === "session.shell"
    )!.frame.params as PromptInput;
    assertEquals({ agent: shell.agent, model: shell.model }, {
      agent: selected.agent,
      model: selected.model,
    });
    assertEquals(Object.hasOwn(shell, "variant"), false);
    const sentNative = await f.oc.request<
      { info: { role: string; agent?: string; model?: unknown } }[]
    >(`/session/${session.id}/message`);
    assert(sentNative.filter((row) => row.info.role === "user").length >= 3);
    assert(
      sentNative.filter((row) => row.info.role === "user").every((row) =>
        row.info.agent === "reviewer"
      ),
    );
    for (const row of sentNative.filter((row) => row.info.role === "user")) {
      const model = row.info.model as { providerID: string; modelID: string };
      assertEquals(
        { provider: model.providerID, model: model.modelID },
        selected.model,
      );
    }
    await b.click(input);
    await b.key("'", 2);
    await b.poll(
      `document.activeElement===document.querySelector('${modelSearch}')`,
    );
    await b.send("Input.insertText", { text: "Plain model" });
    await b.poll(
      "document.querySelectorAll('.otk-model-picker .otk-picker-option').length===1",
    );
    await b.key("Enter");
    await b.poll(
      "!document.querySelector('.otk-variant-picker') && document.activeElement?.name==='prompt' && document.querySelector('.otk-model-picker .otk-composer-model-name')?.textContent==='Plain model'",
    );
    await b.key("'", 2);
    await b.poll(
      `document.activeElement===document.querySelector('${modelSearch}')`,
    );
    await b.send("Input.insertText", { text: "Scripted with variants" });
    await b.poll(
      "document.querySelectorAll('.otk-model-picker .otk-picker-option').length===1",
    );
    await b.key("Enter");
    await b.poll(
      "document.querySelector('.otk-variant-picker > button > span')?.textContent==='Default'",
    );
    await b.key("t", 1);
    await b.poll(
      "document.querySelector('.otk-variant-picker > button > span')?.textContent==='Low'",
    );
    await b.key("k", 2);
    await b.poll("!!document.querySelector('input[name=command-search]')");
    await b.type("input[name=command-search]", "Choose agent");
    await b.poll("!!document.querySelector('[data-command=\"agent.choose\"]')");
    await b.click('[data-command="agent.choose"]');
    await b.poll(
      "!document.querySelector('dialog[open]') && !!document.querySelector('.otk-agent-picker .otk-popover-panel:popover-open') && document.querySelector('.otk-agent-picker .otk-popover-panel')?.contains(document.activeElement)",
    );
    await b.key("Escape");
    await b.poll(
      "document.activeElement===document.querySelector('.otk-agent-picker > button')",
    );
  } finally {
    await client?.close();
    await f.stop();
  }
});

Deno.test("V5 restored missing model remains sendable; catalog loading and errors are unknown, Retry establishes unavailability", async () => {
  const root = await fixture();
  let reject!: (error: Error) => void, calls = 0;
  const sent: PromptInput[] = [];
  const catalog: ModelCatalog = {
    providers: [{
      id: "connected",
      name: "Connected provider",
      models: [{
        id: "available",
        name: "Available model",
        variants: [],
        status: "active",
        free: false,
      }],
    }],
  };
  const { app, url } = await coreBackendFixture(root, {
    models: {
      listModels: () =>
        ++calls === 1
          ? new Promise<ModelCatalog>((_resolve, fail) => {
            reject = fail;
          })
          : calls === 3
          ? Promise.reject(new Error("Refresh failed"))
          : Promise.resolve(catalog),
    },
    prompt: {
      prompt: (input) => {
        sent.push(input);
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
    },
  });
  const list = app.backend.core.listMessages;
  app.backend.core.listMessages = async (...args) =>
    (await list(...args)).map((message) =>
      message.role === "user"
        ? {
          ...message,
          model: { provider: "disconnected", model: "restored-model" },
          agent: "build",
        }
        : message
    );
  const b = await Browser.launch(root);
  try {
    await b.goto(`${url}/#/local/core`);
    await b.poll(
      "document.querySelector('.otk-model-picker .otk-composer-model-name')?.textContent==='restored-model'",
    );
    await open(b, "model");
    await b.poll(
      "document.querySelector('.otk-model-picker [role=status]')?.textContent==='Loading…'",
    );
    assertEquals(
      await b.evaluate(
        "!!document.querySelector('.otk-model-picker .otk-picker-empty')",
      ),
      false,
      "Loading is not an empty catalog",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-model-picker').textContent.includes('unavailable')",
      ),
      false,
    );
    reject(new Error("Catalog temporarily unreachable"));
    await b.poll(
      "document.querySelector('.otk-model-picker [role=alert]')?.textContent.includes('Catalog temporarily unreachable')",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-model-picker').textContent.includes('unavailable')",
      ),
      false,
    );
    await b.click(".otk-model-picker [role=alert] button");
    await b.poll(
      "document.querySelector('.otk-model-picker').textContent.includes('disconnected/restored-model — unavailable') && !document.querySelector('.otk-model-picker [role=alert]')",
    );
    await b.key("Escape");
    await b.type(input, "Send with restored unavailable identity");
    await b.key("Enter");
    await waitFor(() => sent, (rows) => rows.length === 1);
    assertEquals(sent[0].model, {
      provider: "disconnected",
      model: "restored-model",
    });
    assertEquals(sent[0].agent, "build");
    await open(b, "model");
    await b.poll(
      "document.querySelector('.otk-model-picker [role=alert]')?.textContent.includes('Refresh failed')",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-model-picker .otk-picker-name > span')?.textContent",
      ),
      "Available model",
    );
    await b.click(".otk-model-picker [role=alert] button");
    await b.poll(
      "!document.querySelector('.otk-model-picker [role=alert]') && !document.querySelector('.otk-model-picker [role=status]')",
    );
    assertEquals(calls, 4);
  } finally {
    await b.close();
    await app.stop();
  }
});

Deno.test("V5 backend without model capability renders a plain model label and makes no catalog request", async () => {
  const root = await fixture(), { app, url } = await coreBackendFixture(root);
  const b = await Browser.launch(root);
  try {
    await b.goto(`${url}/#/local/core`);
    await b.poll(
      "document.querySelector('.otk-prompt-context')?.textContent.includes('Default model')",
    );
    assertEquals(
      await b.evaluate("!!document.querySelector('.otk-model-picker')"),
      false,
    );
    assertEquals(
      sentFrames(b).some(({ frame }) => frame.method === "models.list"),
      false,
    );
  } finally {
    await b.close();
    await app.stop();
  }
});

Deno.test("round2 prompt snapshots the agent/model/variant picked while first catalog readiness is pending", async () => {
  const root = await fixture(), sent: PromptInput[] = [];
  let resolve!: (catalog: ModelCatalog) => void;
  const pending = new Promise<ModelCatalog>((done) => {
    resolve = done;
  });
  const model = { provider: "later", model: "choice" };
  const { app, url } = await coreBackendFixture(root, {
    agents: {
      listAgents: () =>
        Promise.resolve([{ name: "build" }, {
          name: "review",
          model,
          variant: "high",
        }]),
    },
    models: { listModels: () => pending },
    prompt: {
      prompt: (value) => {
        sent.push(value);
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
    },
  });
  const b = await Browser.launch(root);
  try {
    await b.goto(`${url}/#/local/core`);
    await b.poll("!!document.querySelector('.otk-agent-picker')");
    await b.type(input, "Capture the choice made during readiness");
    await b.key("Enter");
    await open(b, "agent");
    await b.poll(
      `!!document.querySelector('.otk-agent-picker ${option("review")}')`,
    );
    await b.click(`.otk-agent-picker ${option("review")}`);
    await b.poll(
      "document.querySelector('.otk-composer-agent')?.textContent==='Review'",
    );
    assertEquals(sent.length, 0);
    resolve({
      providers: [{
        id: "later",
        name: "Later",
        models: [{
          id: "choice",
          name: "Ready choice",
          variants: ["high"],
          status: "active",
          free: false,
        }],
      }],
    });
    await waitFor(() => sent, (rows) => rows.length === 1);
    assertEquals({
      agent: sent[0].agent,
      model: sent[0].model,
      variant: sent[0].variant,
    }, { agent: "review", model, variant: "high" });
    assertEquals(sent[0].parts, [{
      kind: "text",
      text: "Capture the choice made during readiness",
    }]);
    await b.poll("document.querySelector('textarea[name=prompt]').value===''");
  } finally {
    await b.close();
    await app.stop();
  }
});

Deno.test("round2 failed unknown catalog preserves the restored variant in the footer and at the prompt consumer", async () => {
  const root = await fixture(), sent: PromptInput[] = [];
  const { app, url } = await coreBackendFixture(root, {
    models: { listModels: () => Promise.reject(new Error("Catalog offline")) },
    prompt: {
      prompt: (value) => {
        sent.push(value);
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
    },
  });
  const list = app.backend.core.listMessages;
  app.backend.core.listMessages = async (...args) =>
    (await list(...args)).map((message) =>
      message.role === "user"
        ? {
          ...message,
          agent: "review",
          model: { provider: "offline", model: "restored" },
          variant: "high",
        }
        : message
    );
  const b = await Browser.launch(root);
  try {
    await b.goto(`${url}/#/local/core`);
    await b.poll(
      "document.querySelector('.otk-prompt-context > span:last-child')?.textContent==='High'",
    );
    assertEquals(
      await b.evaluate(
        "document.querySelector('.otk-composer-provider')?.textContent",
      ),
      "offline",
    );
    await open(b, "model");
    await b.poll(
      "document.querySelector('.otk-model-picker [role=alert]')?.textContent.includes('Catalog offline')",
    );
    assertEquals(
      await b.evaluate(
        "!!document.querySelector('.otk-model-picker .otk-picker-empty')",
      ),
      false,
      "Failure is not an empty catalog",
    );
    await b.key("Escape");
    await b.type(input, "Keep the unknown restored variant");
    await b.key("Enter");
    await waitFor(() => sent, (rows) => rows.length === 1);
    assertEquals({
      agent: sent[0].agent,
      model: sent[0].model,
      variant: sent[0].variant,
    }, {
      agent: "review",
      model: { provider: "offline", model: "restored" },
      variant: "high",
    });
  } finally {
    await b.close();
    await app.stop();
  }
});

Deno.test("U2 native null selection metadata stays absent while the model catalog is pending and at the prompt consumer", async () => {
  const root = await fixture(), settings = cfg();
  settings.harness.db = join(root, "absent.db");
  const native = new Opencode1Adapter(settings, undefined, (input) => {
    const path = new URL(String(input)).pathname;
    return Promise.resolve(Response.json(
      path === "/agent"
        ? [{
          name: "build",
          mode: "primary",
          description: null,
          color: null,
          model: null,
          variant: null,
        }]
        : { directory: root },
    ));
  });
  const pending = Promise.withResolvers<ModelCatalog>();
  const sent: PromptInput[] = [];
  const { app, url } = await coreBackendFixture(root, {
    agents: native.capabilities.agents,
    models: { listModels: () => pending.promise },
    prompt: {
      prompt: (value) => {
        sent.push(value);
        return Promise.resolve();
      },
      abort: () => Promise.resolve(),
    },
  });
  app.backend.core.listMessages = () =>
    Promise.resolve([mapMessage(JSON.parse(JSON.stringify({
      id: "restored",
      sessionID: "core",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: null,
    })))]);
  const b = await Browser.launch(root);
  try {
    await b.goto(`${url}/#/local/core`);
    await b.poll(
      "document.querySelector('.otk-composer-agent')?.textContent==='Build' && !!document.querySelector('.otk-model-picker > button')",
    );
    await open(b, "model");
    await b.poll(
      "document.querySelector('.otk-model-picker [role=status]')?.textContent==='Loading…'",
    );
    assertEquals(
      await b.evaluate(
        "!!document.querySelector('.otk-variant-picker') || !!document.querySelector('.otk-prompt-context > span:not(.otk-popover)')",
      ),
      false,
    );
    assertEquals(b.errors, []);
    await b.key("Escape");
    pending.resolve({
      default: { provider: "fixture", model: "plain" },
      providers: [{
        id: "fixture",
        name: "Fixture provider",
        models: [{
          id: "plain",
          name: "Plain model",
          variants: [],
          status: "active",
          free: false,
        }],
      }],
    });
    await b.poll(
      "document.querySelector('.otk-composer-provider')?.textContent==='Fixture provider' && document.querySelector('.otk-composer-model-name')?.textContent==='Plain model'",
    );
    await b.type(input, "Send with native absence");
    await b.key("Enter");
    await waitFor(() => sent, (rows) => rows.length === 1);
    assertEquals(sent[0].agent, "build");
    assertEquals(sent[0].model, { provider: "fixture", model: "plain" });
    assertEquals(
      Object.hasOwn(JSON.parse(JSON.stringify(sent[0])), "variant"),
      false,
    );
    assertEquals(b.errors, []);
  } finally {
    pending.resolve({ providers: [] });
    await b.close();
    await app.stop();
    await native.core.stop();
    assertEquals(
      b.errors,
      [],
      "Native absence must not throw during rendering",
    );
  }
});
