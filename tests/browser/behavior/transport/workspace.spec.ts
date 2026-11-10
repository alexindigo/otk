// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { isolatedTest } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { scrollTranscript, wheelTranscript } from "../../pages/transcript.ts";

const markdown = [
  "# Streaming\n\n",
  "An incremental reply.\n\n",
  "- first\n- second\n\n",
  "```ts\nconst otk = 1;\n```\n",
];

isolatedTest("transport.workspace-projects", {
  tag: ["@transport", "@isolated", "@sessions"],
}, async ({ isolatedState: state, page }, info) => {
  // V2 exposes the canonical repo context above this fixture's scoped leaf.
  const projects = info.project.name === "oc-2.2.6" ? 3 : 2;
  const root = await state.native<{ id: string }>("/session", "POST", {
    title: "Root session",
  });
  const child = await state.native<{ id: string }>("/session", "POST", {
    title: "Child session",
    parentID: root.id,
  });
  const other = await state.controller.call<{ id: string; directory: string }>(
    "nativeRequest",
    {
      lease: state.lease.lease,
      path: "/session",
      method: "POST",
      body: { title: "Other project" },
      project: "secondary",
    },
  );
  await openSession(state, page, root.id);
  await expect(page.locator("[data-project]")).toHaveCount(projects);
  await expect(page.locator("[data-session]")).toHaveCount(2);
  expect(
    await page.locator(`[data-session="${child.id}"]`).evaluate((element) =>
      element.closest<HTMLElement>("[data-parent]")?.dataset.parent
    ),
  ).toBe(root.id);
  await expect(page.locator(`[data-session="${other.id}"]`)).toHaveCount(0);
  await openSession(state, page, other.id);
  expect(
    await page.locator(`[data-session="${other.id}"]`).evaluate((element) =>
      element.closest<HTMLElement>("[data-session-project]")?.dataset
        .sessionProject
    ),
  ).toBe(other.directory);
  const html = await (await page.request.get(state.url)).text();
  for (const path of ["/login", "/setup", "/nested/route", "/assets/"]) {
    const response = await page.request.get(state.url + path);
    expect(response.status()).toBe(200);
    expect((await response.text()).replace(/<base href="[^"]*">/, "")).toBe(
      html.replace(/<base href="[^"]*">/, ""),
    );
  }
  const asset = await page.request.get(
    new URL(/src="([^"]+\.js)"/.exec(html)![1], state.url + "/").href,
  );
  expect(asset.status()).toBe(200);
  expect(asset.headers()["content-type"]).toBe(
    "text/javascript; charset=utf-8",
  );
  expect((await page.request.get(state.url + "/api/missing")).status()).toBe(
    404,
  );
  await page.goto(state.url + "/nested/route");
  await expect(page.locator("[data-project]")).toHaveCount(projects);
  await openSession(state, page, root.id);
  await expect(page.locator("[data-session]")).toHaveCount(2);
  await page.goto(state.url);
  await expect(page.locator("[data-project]")).toHaveCount(projects);
  await openSession(state, page, other.id);
  await expect(page.locator("[data-session]")).toHaveCount(1);
});

test("transport.incremental-markdown", {
  tag: ["@transport", "@messages"],
}, async ({ state, page }) => {
  const seed = await state.native<{ id: string }>("/session", "POST", {
    title: "Existing project",
  });
  await openSession(state, page, seed.id);
  await page.locator(".otk-project-tabs .otk-new-session").click();
  await expect(page).not.toHaveURL(new RegExp(`${seed.id}$`));
  const id = new URL(page.url()).hash.split("/").at(-1)!;
  const gate = await state.queue(markdown, "stepped");
  await page.locator("textarea[name=prompt]").fill(
    "Show the scripted markdown",
  );
  await page.locator("textarea[name=prompt]").press("Enter");
  const lengths = new Set<number>();
  for (let i = 0; i < markdown.length; i++) {
    await state.release(gate.gate);
    await expect(page.locator("[data-role=assistant] .otk-text")).toContainText(
      i === 0
        ? "Streaming"
        : i === 1
        ? "An incremental reply."
        : i === 2
        ? "second"
        : "const otk = 1;",
    );
    if (i < markdown.length - 1) {
      await expect(page.locator(`[data-session="${id}"]`)).toHaveAttribute(
        "data-status",
        "busy",
      );
      lengths.add(
        (await page.locator("[data-role=assistant] .otk-text").textContent())!
          .length,
      );
    }
  }
  expect(lengths.size).toBeGreaterThanOrEqual(3);
  await expect(page.locator(`[data-session="${id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator(".otk-text h1")).toHaveText("Streaming");
  await expect(page.locator(".otk-text ul")).toBeVisible();
  await expect(page.locator(".otk-text pre")).toContainText("const otk = 1;");
  const text = await page.locator("[data-role=assistant] .otk-text")
    .textContent();
  expect(text).not.toContain("# Streaming");
  expect(text).not.toContain("```");
  await expect.poll(async () =>
    await page.locator(".otk-session-crumb[aria-current] .otk-crumb-title")
      .textContent()
  ).toBe(
    await page.locator(`[data-session="${id}"] .otk-row-title`).textContent(),
  );
});

test("transport.interrupt-confirmation", {
  tag: ["@transport", "@messages", "@attention"],
}, async ({ state, page }) => {
  const session = await state.native<{ id: string }>("/session", "POST", {
    title: "Interrupt",
  });
  const frames = await wire(page);
  await openSession(state, page, session.id);
  await state.queue(["continuing "], "held");
  await page.locator("textarea[name=prompt]").fill("Continue slowly");
  await page.locator("textarea[name=prompt]").press("Enter");
  await expect(page.locator("[data-role=assistant] .otk-text")).toBeVisible();
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "busy",
  );
  await page.keyboard.press("Escape");
  await expect(
    page.locator(".otk-prompt [data-interrupt-confirmation][role=status]"),
  ).toHaveText("Esc again to interrupt");
  await expect(page.locator(".otk-prompt button[type=submit]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".otk-message-footer")).toContainText(
    "interrupted",
  );
  await expect(page.locator(`[data-session="${session.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  expect(frames.sent.some(({ frame }) => frame.method === "session.abort"))
    .toBe(true);
  await expect(
    page.locator(
      `[data-session="${session.id}"] .otk-status-light[data-state=blocked]`,
    ),
  ).toBeVisible();
});

isolatedTest.describe("native stream recovery", () => {
  isolatedTest.use({ profile: "transport-freeze" });
  isolatedTest("transport.frozen-stream", {
    tag: ["@transport", "@isolated", "@messages"],
  }, async ({ isolatedState: state, page }, info) => {
    isolatedTest.setTimeout(120_000);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Recovery",
    });
    await openSession(state, page, session.id);
    const gate = await state.queue(markdown, "stepped");
    await page.locator("textarea[name=prompt]").fill("Stream then recover");
    await page.locator("textarea[name=prompt]").press("Enter");
    await state.release(gate.gate);
    await expect(page.locator("[data-role=assistant] .otk-text")).toContainText(
      "Streaming",
    );
    let navigations = 0;
    page.on("framenavigated", () => navigations++);
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "freeze",
    });
    // Complete the real native reply during the outage, so future live delivery
    // cannot conceal a missing recovery/refetch of the current terminal source.
    for (let i = 1; i < markdown.length; i++) await state.release(gate.gate);
    await expect.poll(async () =>
      (await state.native<
        {
          info: { role: string; time: { completed?: number } };
          parts: unknown[];
        }[]
      >(`/session/${session.id}/message`)).some((row) =>
        row.info.role === "assistant" &&
        row.info.time.completed !== undefined &&
        JSON.stringify(row.parts).includes("const otk = 1;")
      )
    ).toBe(true);
    await expect(page.locator(".otk-text pre")).toHaveCount(0);
    await expect(page.locator(".otk-server-status[data-connection=local]"))
      .toHaveAttribute("title", /agent service reconnecting/, {
        timeout: info.project.name === "oc-2.2.6" ? 55_000 : 10_000,
      });
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "thaw",
    });
    await expect(page.locator(".otk-text pre")).toContainText("const otk = 1;");
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
    await expect(page.locator(".otk-text h1")).toHaveText("Streaming");
    await expect(
      page.locator("[data-role=assistant] .otk-text").getByText(
        "An incremental reply.",
        { exact: true },
      ),
    )
      .toHaveText(
        "An incremental reply.",
      );
    await expect(page.locator(".otk-text li")).toHaveText(["first", "second"]);
    expect(navigations).toBe(0);
  });
});

isolatedTest("transport.setup-history", {
  tag: ["@transport", "@isolated", "@sessions"],
}, async ({ isolatedState: state, page }) => {
  const a = await state.native<{ id: string }>("/session", "POST", {
    title: "History A",
  });
  const b = await state.native<{ id: string }>("/session", "POST", {
    title: "History B",
  });
  const { url } = await state.controller.call<{ url: string }>("auxiliary", {
    lease: state.lease.lease,
    kind: "setup",
  });
  await page.goto(url);
  await page.locator("input[name=username]").fill("tester");
  await page.locator("input[name=password]").fill("secret");
  await page.locator(".otk-auth-view button[type=submit]").click();
  await expect(page.locator(".otk-auth-view")).toHaveCount(0);
  await expect(page.locator(".otk-corner-right")).toBeEnabled();
  expect((await page.context().cookies(url)).some((cookie) => cookie.httpOnly))
    .toBe(true);
  await page.goto(`${url}/#/local/${a.id}`);
  await page.getByRole("button", { name: "Open right panel", exact: true })
    .click();
  await page.getByRole("complementary", { name: "Right panel", exact: true })
    .getByRole("tab", { name: "Sessions", exact: true }).click();
  await page.locator(`[data-session="${b.id}"]`).click();
  await page.goBack();
  await expect(page).toHaveURL(`${url}/#/local/${a.id}`);
  await expect(
    page.locator(".otk-session-crumb[aria-current] .otk-crumb-title"),
  ).toHaveText("History A");
  await page.goForward();
  await expect(page).toHaveURL(`${url}/#/local/${b.id}`);
  await expect(
    page.locator(".otk-session-crumb[aria-current] .otk-crumb-title"),
  ).toHaveText("History B");
  expect(await (await page.request.get(url + "/api/session")).json()).toEqual({
    authenticated: true,
    setupRequired: false,
    authType: "password",
  });
});

test(
  "transport.history-viewport",
  { tag: ["@transport", "@messages"] },
  async ({ state, page }) => {
    test.setTimeout(120_000);
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Long history",
      messages: Array.from(
        { length: 103 },
        (_, i) => ({ parts: [{ type: "text", text: `History row ${i}` }] }),
      ),
    });
    await openSession(state, page, session.id);
    const flow = page.locator(".otk-message-flow"),
      viewport = page.locator(".otk-messages");
    await expect.poll(async () =>
      Number(await flow.getAttribute("data-message-count"))
    ).toBeGreaterThanOrEqual(20);
    expect(Number(await flow.getAttribute("data-message-count"))).toBeLessThan(
      103,
    );
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(100);
    await viewport.hover();
    await expect.poll(async () => {
      await page.mouse.wheel(0, -100000);
      return await flow.getAttribute("data-message-count") === "103" &&
        (await viewport.textContent())!.includes("History row 0");
    }).toBe(true);
    expect(await page.locator("[data-message]").count()).toBeLessThan(103);
    const before = await viewport.evaluate((el) => el.scrollTop);
    const gate = await state.queue(
      Array(30).fill("While you read older messages. "),
      "held",
    );
    await page.locator("textarea[name=prompt]").fill(
      "Stay above the new response",
    );
    await page.locator("textarea[name=prompt]").press("Enter");
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "busy");
    await state.release(gate.gate);
    await expect.poll(async () =>
      (await state.native<
        { info: { role: string; time: { completed?: number } } }[]
      >(`/session/${session.id}/message`)).some((row) =>
        row.info.role === "assistant" && row.info.time.completed !== undefined
      )
    ).toBe(true);
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
    const after = await viewport.evaluate((el) => ({
      top: el.scrollTop,
      gap: el.scrollHeight - el.clientHeight - el.scrollTop,
    }));
    expect(Math.abs(before - after.top)).toBeLessThan(2);
    expect(after.gap).toBeGreaterThan(100);
    await viewport.hover();
    await page.mouse.wheel(0, 100000);
    await expect.poll(() =>
      viewport.evaluate((el) =>
        el.scrollHeight - el.clientHeight - el.scrollTop
      )
    ).toBeLessThan(2);
    const next = await state.queue(markdown, "held");
    await page.locator("textarea[name=prompt]").fill("Follow the bottom");
    await page.locator("textarea[name=prompt]").press("Enter");
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "busy");
    await state.release(next.gate);
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
    await expect(page.locator(".otk-text pre")).toBeVisible();
    await expect.poll(() =>
      viewport.evaluate((el) =>
        el.scrollHeight - el.clientHeight - el.scrollTop
      )
    ).toBeLessThan(2);
  },
);

test(
  "transport.typed-markdown",
  { tag: ["@transport", "@messages"] },
  async ({ state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Typed markdown",
    });
    await openSession(state, page, session.id);
    const rich =
      "## Structured content\n\n**strong** *emphasis* ~~deleted~~ `inline` [reference](https://example.test/docs)\n\nline one  \nline two\n\n> quoted content\n\n3. numbered\n4. next item\n\n- [x] checked task\n\n| Name | Value |\n| :--- | ---: |\n| alpha | 42 |\n\n---\n\n![fixture](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2WQAAAAASUVORK5CYII=)\n";
    await state.queue([rich]);
    await page.locator("textarea[name=prompt]").fill(
      "Render the structured fixture",
    );
    await page.locator("textarea[name=prompt]").press("Enter");
    await expect(page.locator(`[data-session="${session.id}"]`))
      .toHaveAttribute("data-status", "idle");
    await expect(page.locator(".otk-text table")).toBeAttached();
    const viewport = page.locator(".otk-messages");
    await scrollTranscript(page, false);
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0);
    const rendered: Record<string, unknown> = {};
    while (true) {
      const visible = await page.locator("[data-role=assistant] .otk-text")
        .evaluate((el) => ({
          heading: el.querySelector("h2")?.textContent,
          strong: el.querySelector("strong")?.textContent,
          em: el.querySelector("em")?.textContent,
          del: el.querySelector("del")?.textContent,
          code: el.querySelector("code")?.textContent,
          link: el.querySelector("a")?.getAttribute("rel"),
          target: el.querySelector("a")?.target,
          br: !!el.querySelector("br"),
          quote: el.querySelector("blockquote")?.textContent?.trim(),
          start: el.querySelector("ol")?.start,
          task: el.querySelector('.otk-task-marker[role="img"]')
            ?.getAttribute("aria-label") === "Done",
          rule: !!el.querySelector("hr"),
          cells: Array.from(el.querySelectorAll("td")).map((cell) =>
            cell.textContent
          ),
          image: el.querySelector("img")?.alt,
        }));
      for (const [key, value] of Object.entries(visible)) {
        if (
          value !== undefined && value !== null && value !== false &&
          (!Array.isArray(value) || value.length)
        ) rendered[key] = value;
      }
      const position = await viewport.evaluate((el) => ({
        top: el.scrollTop,
        end: el.scrollHeight - el.clientHeight,
        height: el.clientHeight,
      }));
      if (position.top >= position.end - 1) break;
      await wheelTranscript(page, position.height / 2);
      await expect.poll(() => viewport.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(position.top);
    }
    expect(rendered).toEqual({
      heading: "Structured content",
      strong: "strong",
      em: "emphasis",
      del: "deleted",
      code: "inline",
      link: "noopener noreferrer",
      target: "_blank",
      br: true,
      quote: "quoted content",
      start: 3,
      task: true,
      rule: true,
      cells: ["alpha", "42"],
      image: "fixture",
    });
    await expect(page.locator(".otk-text img")).toHaveJSProperty(
      "naturalWidth",
      1,
    );
  },
);
