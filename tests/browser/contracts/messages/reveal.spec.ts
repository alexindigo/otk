// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import {
  compactionBoundary,
  expectCompactionSummary,
  openActivityGroups,
  openWork,
  recordToggle,
  revealAcquired,
  runNativeTool,
  workPanel,
} from "../../pages/transcript.ts";

test.use({ profile: "messages-forms" });

test("messages.reveal-joins-delayed-browser-publication", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Publication fence",
  });
  const capture = await wire(page);
  await openSession(state, page, session.id);
  const part = await runNativeTool(state, page, session.id, "bash", {
    command: "echo publication-fence",
    description: "Delayed publication",
  });
  // A fresh browser window has no admitted record even though native work is
  // complete. Delay its atomic source page, not a partial live-clock stream.
  capture.hold((frame, request) =>
    frame.t === "load.chunk" ||
    frame.t === "request.result" && request?.method === "session.messages"
  );
  await page.reload();
  await expect.poll(() => capture.held.length).toBeGreaterThan(0);
  let settled = false;
  const reveal = revealAcquired(page, `[data-message="${part.messageID}"]`)
    .then(() => {
      settled = true;
    });
  try {
    await expect.poll(async () => {
      const messages = await state.native<
        {
          info: { finish?: string };
          parts: { type: string; text?: string }[];
        }[]
      >(`/session/${session.id}/message`);
      return messages.some((message) =>
        message.info.finish === "stop" &&
        message.parts.some((part) => part.text === "Finished bash.")
      );
    }).toBe(true);
    await expect.poll(() => capture.held.length).toBeGreaterThan(0);
    expect(
      settled,
      "Native completion must not exhaust an unpublished viewport",
    ).toBe(false);
  } finally {
    capture.release();
  }
  await reveal;
  await openWork(page.locator(`[data-message="${part.messageID}"]`));
  await expect(
    workPanel(page).locator("[data-tool=bash]"),
  ).toBeVisible();
});

test(
  "messages.record-disclosure-ignores-tree-wrappers-and-rejects-a-source-toggle",
  {
    tag: ["@messages", "@contracts"],
  },
  async ({ page }) => {
    await page.setContent(
      `<section data-native-record="fixture"><div class="tree-heading"><div class="tree-label"><header class="otk-tool-state"><button class="otk-tool-toggle" aria-expanded="false">Record</button></header></div></div><div class="otk-native-source"><button class="otk-tool-toggle">Source</button></div></section>`,
    );
    const record = page.locator('[data-native-record="fixture"]');
    await expect(recordToggle(record)).toHaveText("Record");
    await record.locator(".otk-tool-state").evaluate((state) => state.remove());
    expect(
      await recordToggle(record).count(),
      "A Source button cannot substitute for its missing record owner",
    ).toBe(0);
  },
);

test(
  "messages.reveal-rejects-a-published-record-with-broken-disclosure-membership",
  {
    tag: ["@messages", "@contracts"],
  },
  async ({ page }) => {
    await page.setContent(
      `<div class="otk-messages" aria-busy="false" style="height:200px;overflow:auto"><section data-record-members='["another-record"]'><header><button class="otk-record-group-toggle" aria-expanded="false">Activity</button></header></section></div>`,
    );
    await page.evaluate(() => {
      Object.assign(globalThis, {
        transcriptPublication: new Map([["missing-record", {
          id: "missing-record",
          parts: [{ id: "part", kind: "external", name: "fixture" }],
        }]]),
      });
    });
    await expect(revealAcquired(page, '[data-message="missing-record"]'))
      .rejects.toThrow("Acquired target is unavailable");
  },
);

test("messages.work-reveal-survives-virtual-segment-replacement", {
  tag: ["@messages", "@contracts"],
}, async ({ page, isolatedState: state }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Reveal a work record",
  });
  await openSession(state, page, session.id);
  const work = await runNativeTool(state, page, session.id, "bash", {
    command: "pwd",
    description: "Locate project directory",
  });
  const reply = page.locator(`[data-message="${work.messageID}"]`);
  const strip = reply.locator(".otk-work-strip");
  await page.getByRole("tab", { name: "Sessions", exact: true }).click();
  await expect(workPanel(page)).toHaveCount(0);
  // Native tool IDs and the projected part IDs differ on V2. Select the
  // declared run from its visible strip and check that the same run is shown.
  const segment = strip.getByTitle(/^Locate project directory,/);
  await expect(segment).toHaveAttribute("data-run", /\S+/);
  const run = await segment.getAttribute("data-run");
  await segment.click();
  const selected = workPanel(page).locator(
    `[data-work-run=${JSON.stringify(run)}]`,
  );
  await expect(selected).toHaveClass(/is-selected/);
  await expect(selected).toContainText("Locate project directory");
  await expect(strip).toHaveAttribute("aria-current", "true");
  await expect(strip).toBeInViewport();
});

test("messages.work-reveal-reacquires-a-retired-disclosure", {
  tag: ["@messages", "@contracts"],
}, async ({ page }) => {
  await page.setContent(
    `<div class="otk-messages" aria-busy="false" style="height:200px;overflow:auto"><button class="otk-record-group-toggle" aria-expanded="false">Temporary Activity</button><article data-message="reply" hidden><button class="otk-record-group-toggle" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Retained activity</button></article></div>`,
  );
  await page.evaluate(() => {
    const ready = document.fonts.ready;
    Object.defineProperty(document.fonts, "ready", {
      get() {
        document.querySelector(".otk-messages > .otk-record-group-toggle")
          ?.remove();
        document.querySelector("article")!.hidden = false;
        return ready;
      },
    });
  });
  await openActivityGroups(page);
  await expect(page.getByRole("button", { name: "Retained activity" }))
    .toHaveAttribute("aria-expanded", "true");
});

test("messages.compaction-summary-reveal-opens-published-ancestry", {
  tag: ["@messages", "@contracts"],
}, async ({ page, isolatedState: state }) => {
  const { selector } = compactionBoundary(state);
  const name = /"([^"]+)"/.exec(selector)![1];
  // Reader acquisition addresses the same prose-body slot as the native record,
  // separately from its header and the surrounding ancestry disclosure.
  await page.setContent(
    `<div class="otk-messages" aria-busy="false" style="height:200px;overflow:auto"><article data-message="older"><section data-native-record="${name}"><header class="otk-tool-state"><button class="otk-tool-toggle" aria-expanded="true">Earlier compaction</button></header><div class="otk-tool-body"><div class="otk-text">Earlier summary.</div></div></section></article><section data-record-members='["summary"]'><button class="otk-record-group-toggle" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');this.nextElementSibling.hidden=false">Activity</button><article hidden data-message="summary"><section data-native-record="${name}"><header class="otk-tool-state"><button class="otk-tool-toggle" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');this.parentElement.nextElementSibling.hidden=false">Session compacted</button></header><div hidden class="otk-tool-body"><div class="otk-text">Retained summary content.</div></div></section></article></section></div>`,
  );
  await page.evaluate((name) => {
    Object.assign(globalThis, {
      transcriptPublication: new Map([["older", {
        id: "older",
        parts: [{
          id: "older-part",
          kind: "external",
          name,
          source: { payload: "Earlier summary." },
        }],
      }], ["summary", {
        id: "summary",
        parts: [{
          id: "summary-part",
          kind: "external",
          name,
          source: { payload: "Retained summary content." },
        }],
      }]]),
    });
  }, name);
  await expectCompactionSummary(state, page, "Retained summary content.");
  await expect(page.locator(`[data-message="summary"] ${selector}`))
    .toContainText(
      "Retained summary content.",
    );
  await expect(page.locator(".otk-record-group-toggle")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});
