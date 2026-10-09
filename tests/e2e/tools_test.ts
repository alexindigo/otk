// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { recordTools, runTool } from "../support/rendering.ts";
import { waitFor } from "../support/opencode.ts";
import type { RawPart } from "../../sidecar/adapter/opencode1/types.ts";
Deno.test("R1 bash output is ten lines, expands to thirty, and displays differing cwd", async () => {
  const f = await browserFixture({ bash: "allow" }, {
    prepare: async (oc) => {
      await Deno.mkdir(join(oc.directory, "sub"));
    },
  });
  try {
    const s = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Bash rendering" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, s.id);
    const raw = await runTool(f, browser, s.id, {
      name: "bash",
      input: {
        command: "seq 1 30",
        description: "Thirty lines",
        workdir: join(f.oc.directory, "sub"),
      },
    });
    await browser.poll(
      "document.querySelector('[data-tool=bash] .otk-tool-output')?.textContent.split('\\n').length===10",
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-tool=bash]').textContent.includes('Running in')",
      ),
      true,
    );
    await browser.screenshot(join(f.oc.root, "r1-bash-collapsed.png"));
    await browser.click("[data-tool=bash] .otk-output-toggle");
    await browser.poll(
      "document.querySelector('[data-tool=bash] .otk-tool-output').textContent.split('\\n').length===30",
    );
    await browser.screenshot(join(f.oc.root, "r1-bash-expanded.png"));
    await recordTools(f.oc.root, "recorded-basic-tools", [raw]);
  } finally {
    await f.stop();
  }
});
Deno.test("R4 real read, directory listing, glob, grep, local fetch, skill and generic output forms", async () => {
  const http = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () =>
      new Response("OTK fetch fixture", {
        headers: { "Content-Type": "text/plain" },
      }),
  );
  const f = await browserFixture({
    bash: "allow",
    read: "allow",
    glob: "allow",
    grep: "allow",
    webfetch: "allow",
    skill: "allow",
  }, {
    prepare: async (oc) => {
      await Deno.mkdir(join(oc.directory, "src"));
      await Deno.writeTextFile(
        join(oc.directory, "src/AGENTS.md"),
        "# Fixture instructions\nRead the fixture only.\n",
      );
      await Deno.writeTextFile(
        join(oc.directory, "src/probe.txt"),
        "first\notk_marker\nthird\n",
      );
      await Deno.mkdir(join(oc.directory, ".opencode/skills/otk-fixture"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(oc.directory, ".opencode/skills/otk-fixture/SKILL.md"),
        "---\nname: otk-fixture\ndescription: OTK rendering fixture\n---\nRead only this fixture.\n",
      );
      await Deno.mkdir(join(oc.directory, ".opencode/tools"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(oc.directory, ".opencode/tools/echo_fixture.ts"),
        "export default {description:'Local generic output fixture',args:{},async execute(){return 'first\\nsecond\\nthird\\nfourth\\nfifth'}};",
      );
    },
  });
  try {
    const s = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Tool forms" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, s.id);
    const parts: RawPart[] = [];
    parts.push(
      await runTool(f, browser, s.id, {
        name: "read",
        input: {
          filePath: join(f.oc.directory, "src/probe.txt"),
          offset: 2,
          limit: 1,
        },
      }),
    );
    await browser.poll(
      "document.querySelector('[data-tool=read]')?.textContent.includes('↳ Loaded')",
    );
    parts.push(
      await runTool(f, browser, s.id, {
        name: "read",
        input: { filePath: join(f.oc.directory, "src") },
      }),
    );
    await browser.poll(
      "document.querySelector('[data-search-mode=list]')?.textContent.includes('2 entries')",
    );
    parts.push(
      await runTool(f, browser, s.id, {
        name: "glob",
        input: { pattern: "*.txt", path: join(f.oc.directory, "src") },
      }),
    );
    parts.push(
      await runTool(f, browser, s.id, {
        name: "grep",
        input: {
          pattern: "otk_marker",
          path: join(f.oc.directory, "src"),
          include: "*.txt",
        },
      }),
    );
    await browser.poll(
      "document.querySelector('[data-search-mode=glob]')?.textContent.includes('1 matches') && document.querySelector('[data-search-mode=grep]')?.textContent.includes('1 matches')",
    );
    const url = `http://127.0.0.1:${(http.addr as Deno.NetAddr).port}/fixture`;
    parts.push(
      await runTool(f, browser, s.id, {
        name: "webfetch",
        input: { url, format: "text" },
      }),
    );
    await browser.poll(
      `document.querySelector('[data-tool=fetch]')?.textContent.includes(${
        JSON.stringify(url)
      })`,
    );
    parts.push(
      await runTool(f, browser, s.id, {
        name: "skill",
        input: { name: "otk-fixture" },
      }),
    );
    await browser.poll(
      "document.querySelector('[data-tool=skill]')?.textContent.includes('otk-fixture')",
    );
    parts.push(
      await runTool(f, browser, s.id, { name: "echo_fixture", input: {} }),
    );
    await browser.click(".otk-display-menu summary");
    await browser.click("input[name=genericToolOutput]");
    await browser.poll(
      "document.querySelector('[data-tool=generic] .otk-tool-output')?.textContent==='first\\nsecond\\nthird'",
    );
    await browser.click(".otk-display-menu summary");
    await browser.click("[data-tool=generic] .otk-output-toggle");
    await browser.poll(
      "document.querySelector('[data-tool=generic] .otk-tool-output')?.textContent.includes('fifth')",
    );
    await recordTools(f.oc.root, "recorded-form-tools", parts);
    await browser.screenshot(join(f.oc.root, "r4-tool-forms.png"));
  } finally {
    await http.shutdown();
    await f.stop();
  }
});
Deno.test("tool permission warning, denied strikethrough and expandable errors use one state contract", async () => {
  const f = await browserFixture({ bash: "ask", websearch: "ask" }, {
    env: { OPENCODE_ENABLE_EXA: "1" },
  });
  try {
    const s = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Tool states" },
    });
    const server = await f.sidecar(), browser = await f.browser(server.url);
    await openSession(browser, s.id);
    f.fake.queue({
      tool: {
        name: "bash",
        input: { command: "echo denied", description: "Denied" },
      },
    });
    await browser.type("textarea[name=prompt]", "Ask permission");
    await browser.key("Enter");
    await browser.poll(
      "!!document.querySelector('[data-tool=bash].otk-tool-waiting')",
    );
    await browser.click(".otk-permission-actions > button:nth-child(3)");
    await browser.poll("!!document.querySelector('textarea[name=rejection]')");
    await browser.click(".otk-permission-dock button[type=submit]");
    await browser.poll(
      "!!document.querySelector('[data-tool=bash][data-tool-status=denied]')",
    );
    await browser.poll(
      `document.querySelector('[data-session="${s.id}"]').dataset.status==='idle'`,
    );
    f.fake.queue({
      tool: {
        name: "websearch",
        input: { query: "OTK rendering fixture", numResults: 8 },
      },
    });
    await browser.type("textarea[name=prompt]", "Ask web search permission");
    await browser.key("Enter");
    await browser.poll(
      "!!document.querySelector('[data-tool=websearch].otk-tool-waiting')",
    );
    await browser.click(".otk-permission-actions > button:nth-child(3)");
    await browser.poll("!!document.querySelector('textarea[name=rejection]')");
    await browser.click(".otk-permission-dock button[type=submit]");
    await browser.poll(
      "!!document.querySelector('[data-tool=websearch][data-tool-status=denied]')",
    );
    await browser.poll(
      `document.querySelector('[data-session="${s.id}"]').dataset.status==='idle'`,
    );
    assertEquals(
      await browser.evaluate(
        "document.querySelector('[data-tool=websearch]').textContent.includes('count unavailable')",
      ),
      false,
    );
    f.fake.queue({
      tool: {
        name: "read",
        input: { filePath: join(f.oc.directory, "missing.txt") },
      },
    }, { chunks: ["Missing file handled."] });
    await browser.type("textarea[name=prompt]", "Show a tool error");
    await browser.key("Enter");
    await browser.poll(
      "!!document.querySelector('[data-tool=read][data-tool-status=error]')",
    );
    await browser.click("[data-tool=read] .otk-tool-error-toggle");
    await browser.poll(
      "document.querySelector('.otk-tool-error')?.textContent.includes('File not found')",
    );
    await waitFor(
      () => f.oc.request<{ parts: RawPart[] }[]>(`/session/${s.id}/message`),
      (messages) =>
        messages.some((m) =>
          m.parts.some((p) => p.tool === "read" && p.state?.status === "error")
        ),
    );
    const raw = await f.oc.request<{ parts: RawPart[] }[]>(
      `/session/${s.id}/message`,
    );
    await recordTools(
      f.oc.root,
      "recorded-state-tools",
      raw.flatMap((m) => m.parts).filter((p) => p.type === "tool"),
    );
    await browser.screenshot(join(f.oc.root, "tool-states.png"));
  } finally {
    await f.stop();
  }
});
