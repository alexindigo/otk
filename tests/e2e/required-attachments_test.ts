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
import { waitFor } from "../support/opencode.ts";
import { WsClient } from "../support/ws-client.ts";

for (const mode of ["prompt", "command"] as const) {
  for (const fault of ["missing", "unreadable"] as const) {
    test(`${mode} keeps the entire draft when a selected attachment becomes ${fault} and retries with every attachment`, async () => {
      const f = await browserFixture(undefined, {
        async prepare(oc) {
          await Deno.writeTextFile(
            join(oc.directory, "selected.txt"),
            "selected attachment bytes",
          );
          await Deno.writeTextFile(
            join(oc.directory, "good.txt"),
            "good attachment bytes",
          );
          await Deno.mkdir(join(oc.directory, ".opencode/command"), {
            recursive: true,
          });
          await Deno.writeTextFile(
            join(oc.directory, ".opencode/command/probe.md"),
            "---\ndescription: Attachment probe\n---\nReview every attachment: $ARGUMENTS",
          );
        },
      });
      let client: WsClient | undefined;
      try {
        const session = await f.oc.request<{ id: string }>("/session", {
          method: "POST",
          body: { title: "Required attachments" },
        });
        const other = await f.oc.request<{ id: string }>("/session", {
          method: "POST",
          body: { title: "Other draft" },
        });
        const server = await f.sidecar(), browser = await f.browser(server.url);
        client = new WsClient(server.url);
        await client.connect();
        await openSession(browser, session.id);
        await browser.type(
          "textarea[name=prompt]",
          mode === "command" ? "/probe " : "Review ",
        );
        for (const path of ["good.txt", "selected.txt"]) {
          await browser.type("textarea[name=prompt]", "@" + path);
          await browser.poll(
            `document.querySelector('.otk-autocomplete')?.textContent.includes(${
              JSON.stringify(path)
            })`,
          );
          await browser.key("Enter");
          await browser.poll(
            `[...document.querySelectorAll('.otk-prompt-chip')].some(el=>el.textContent.includes(${
              JSON.stringify("@" + path)
            }))`,
          );
        }
        await browser.evaluate(
          "(()=>{const d=new DataTransfer();d.items.add(new File(['uploaded attachment bytes'],'upload.txt',{type:'text/plain'}));document.querySelector('.otk-prompt').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:d}));})()",
        );
        await browser.poll(
          "document.querySelectorAll('.otk-prompt-chip').length===3 && !document.querySelector('.otk-prompt button[type=submit]').disabled",
        );
        const readDraft = () =>
          browser.evaluate<{ input: string; chips: string[] }>(
            "({input:document.querySelector('textarea[name=prompt]').value,chips:[...document.querySelectorAll('.otk-prompt-chip')].map(el=>el.textContent)})",
          );
        const original = await readDraft();
        const path = join(f.oc.directory, "selected.txt");
        if (fault === "missing") await Deno.remove(path);
        else await Deno.chmod(path, 0);
        await browser.click(".otk-prompt button[type=submit]");
        await browser.poll(
          "document.querySelector('.otk-prompt [role=alert]')?.textContent.includes('Cannot read attachment \"selected.txt\"')",
          5000,
        );
        assertEquals(
          await readDraft(),
          original,
          "Failed send cleared text or attachment chips",
        );
        assertEquals(
          f.fake.requests.length,
          0,
          "An incomplete prompt reached the provider",
        );
        assertEquals(
          await f.oc.request(`/session/${session.id}/message`),
          [],
          "Failed admission persisted an incomplete user message",
        );
        const request = sentFrames(browser).findLast(({ frame }) =>
          frame.method === `session.${mode}`
        )!;
        assert(request, "The browser did not submit through the expected path");
        const result = browser.events.findLast((event) =>
          event.method === "Network.webSocketFrameReceived" &&
          JSON.parse(
              (event.params.response as { payloadData: string }).payloadData,
            ).id === request.frame.id
        );
        assert(result);
        const frame = JSON.parse(
          (result.params.response as { payloadData: string }).payloadData,
        );
        assertEquals(frame.t, "rpc.result");
        assertEquals(
          frame.ok,
          false,
          "The attachment failure was acknowledged as success",
        );
        for (const theme of ["otk-dark", "otk-light"]) {
          await client.rpc("prefs.set", { key: "theme", value: theme });
          await browser.poll(
            `document.documentElement.style.colorScheme===${
              JSON.stringify(theme === "otk-dark" ? "dark" : "light")
            }`,
          );
          const capture = join(
            f.oc.root,
            `quality-A3-${mode}-${fault}-${theme}.png`,
          );
          await browser.screenshot(capture);
          console.info("A3 attachment capture:", capture);
        }
        await openSession(browser, other.id);
        await browser.poll(
          "document.querySelector('textarea[name=prompt]').value===''",
        );
        await openSession(browser, session.id);
        assertEquals(
          await readDraft(),
          original,
          "Switching sessions lost the rejected draft",
        );
        if (fault === "missing") {
          await Deno.writeTextFile(path, "selected attachment bytes");
        } else await Deno.chmod(path, 0o600);
        f.fake.queue({ chunks: ["Every attachment received."] });
        await browser.click(".otk-prompt button[type=submit]");
        await waitForReply(browser, session.id, "Every attachment received.");
        await browser.poll(
          "document.querySelector('textarea[name=prompt]').value==='' && document.querySelectorAll('.otk-prompt-chip').length===0",
        );
        await waitFor(
          () => f.fake.requests,
          (requests) =>
            requests.some((request) => {
              const body = JSON.stringify(request.messages);
              return [
                "selected attachment bytes",
                "good attachment bytes",
                "uploaded attachment bytes",
              ].every((text) => body.includes(text));
            }),
        );
        const messages = await f.oc.request<
          {
            info: { role: string };
            parts: { type: string; filename?: string; url?: string }[];
          }[]
        >(`/session/${session.id}/message`);
        const user = messages.filter((message) => message.info.role === "user");
        assertEquals(
          user.length,
          1,
          "The rejected attempt created a duplicate user turn",
        );
        assertEquals(
          user[0].parts.filter((part) => part.type === "file").map((part) =>
            part.filename
          ).sort(),
          ["good.txt", "selected.txt", "upload.txt"],
        );
        assert(
          user[0].parts.some((part) =>
            part.url ===
              "data:text/plain;base64," + btoa("uploaded attachment bytes")
          ),
        );
      } finally {
        // Restore permissions even when a red assertion stops before retry.
        if (fault === "unreadable") {
          await Deno.chmod(join(f.oc.directory, "selected.txt"), 0o600);
        }
        await client?.close();
        await f.stop();
      }
    });
  }
}
