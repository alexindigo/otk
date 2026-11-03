// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture, openSession } from "../support/browser-fixture.ts";
import { focusNotifications } from "../support/notification-browser.ts";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";

for (const theme of ["otk-dark", "otk-light"]) {
  test(`U9 permission toast and takeover share exact bash, generic and edit summaries before approval (${theme})`, () =>
    permissionDetails(theme));
}
async function permissionDetails(theme: string) {
  const f = await browserFixture({ bash: "ask", read: "ask", edit: "ask" });
  let client: WsClient | undefined;
  const shots = Deno.env.get("OTK_PERMISSION_SHOTS");
  try {
    const foreground = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Current conversation" },
    });
    const background = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Review exact permission targets" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    client = new WsClient(server.url);
    await client.connect();
    await client.rpc("prefs.set", { key: "theme", value: theme });
    await client.rpc("prefs.set", { key: "animationsOff", value: true });
    await focusNotifications(b);
    await openSession(b, foreground.id);
    const toast = `.otk-toast[data-note='local/${background.id}']`;
    const capture = async (name: string) => {
      if (!shots) return;
      await Deno.mkdir(shots, { recursive: true });
      for (
        const [theme, suffix] of [["otk-dark", "dark"], ["otk-light", "light"]]
      ) {
        await client!.rpc("prefs.set", { key: "theme", value: theme });
        await b.poll(`document.documentElement.dataset.otkTheme==='${theme}'`);
        await b.screenshot(join(shots, `${name}-${suffix}.png`));
      }
    };
    const compare = async (kind: string, target: string) => {
      await b.poll(
        `document.querySelector("${toast}")?.textContent.includes('Allow once')`,
      );
      await capture(`${kind}-toast`);
      const summary = await b.evaluate<string>(
        `document.querySelector("${toast} .otk-permission-summary")?.textContent`,
      );
      assert(summary?.includes(kind) && summary.includes(target), summary);
      assert(
        await b.evaluate(
          `(()=>{const s=document.querySelector("${toast} .otk-permission-summary"),r=s.getBoundingClientRect(),p=s.closest('.otk-surface').getBoundingClientRect();return r.width>0&&r.left>=p.left&&r.right<=p.right&&getComputedStyle(s).position==='static'})()`,
        ),
      );
      await b.click(`${toast} .otk-toast-actions button:first-child`);
      await b.poll(
        `location.hash.endsWith('/${background.id}') && !!document.querySelector('.otk-permission-dock .otk-permission-summary')`,
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-permission-dock .otk-permission-summary').textContent",
        ),
        summary,
      );
      await capture(`${kind}-takeover`);
      await openSession(b, foreground.id);
    };
    const command = "printf permission-details-result > permission-details.txt";
    f.fake.queue({
      tool: { name: "bash", input: { command, description: "Exact command" } },
    }, { chunks: ["Command finished"] });
    await client.rpc("session.prompt", {
      sessionID: background.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Run the exact command" }],
    });
    await compare("bash", command);
    // Navigating away views the old note; the pending request remains authoritative.
    const requests = await client.rpc<{ id: string }[]>("permission.list", {
      sessionID: background.id,
    });
    await client.rpc("permission.reply", {
      sessionID: background.id,
      requestID: requests[0].id,
      reply: "once",
    });
    await waitFor(
      () => f.oc.request<Record<string, { type: string }>>("/session/status"),
      (state) => !state[background.nativeID],
    );
    const file = join(f.oc.directory, "README.md");
    f.fake.queue({ tool: { name: "read", input: { filePath: file } } }, {
      tool: {
        name: "edit",
        input: {
          filePath: file,
          oldString: "# OTK fixture",
          newString: "# Changed fixture",
        },
      },
    });
    await client.rpc("session.prompt", {
      sessionID: background.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Read then propose an edit" }],
    });
    await compare("read", "README.md");
    const read = await client.rpc<{ id: string }[]>("permission.list", {
      sessionID: background.id,
    });
    await client.rpc("permission.reply", {
      sessionID: background.id,
      requestID: read[0].id,
      reply: "once",
    });
    await compare("edit", file);
    const edit = await client.rpc<{ id: string }[]>("permission.list", {
      sessionID: background.id,
    });
    await client.rpc("permission.reply", {
      sessionID: background.id,
      requestID: edit[0].id,
      reply: "reject",
    });
    // Allow/reject above only admit the next fixed summary state. Real file
    // effects and retained drafts are owned by attention/details.spec.ts.
  } finally {
    await client?.close();
    await f.stop();
  }
}
