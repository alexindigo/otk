// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { type Frame, openSession, wire } from "../../fixtures/wire.ts";
import {
  revealAcquired,
  scrollTranscript,
  toolScript,
  wheelTranscript,
} from "../../pages/transcript.ts";

test.use({ profile: "messages-tools" });

for (
  const trigger of [
    "reconnect-changed-head",
    "restart-changed-head",
    "missing-frame",
    "pending-send",
    "deletion",
  ] as const
) {
  test(
    `messages.reconcile-${trigger}`,
    { tag: ["@messages", "@isolated"] },
    async ({ isolatedState: state, page }, info) => {
      test.setTimeout(120_000);
      const session = await state.native<{ id: string }>("/session", "POST", {
        title: "Transcript reconciliation",
        messages: Array.from(
          { length: 20 },
          (_, i) => ({ parts: [{ type: "text", text: `Seed ${i}` }] }),
        ),
      });
      type NativeMessage = {
        info: {
          id: string;
          role: string;
          finish?: string;
          time: { completed?: number };
        };
        parts: { text?: string }[];
      };
      const nativeMessages = () =>
        state.native<NativeMessage[]>(`/session/${session.id}/message`);
      const waitReply = (reply: string) =>
        expect.poll(
          async () =>
            (await nativeMessages()).some(({ info, parts }) =>
              info.role === "assistant" && !!info.time.completed &&
              info.finish === "stop" && parts.some((part) =>
                part.text === reply
              )
            ),
          { timeout: 30_000 },
        ).toBe(true);
      const send = async (text: string, reply: string, tool = false) => {
        if (tool) {
          await toolScript(state, "bash", {
            command: "true",
            description: "Read anchor",
          }, reply);
        } else await state.queue([reply]);
        await state.native(`/session/${session.id}/prompt_async`, "POST", {
          agent: "build",
          model: { providerID: "fake", modelID: "scripted" },
          parts: [{ type: "text", text }],
        });
        await waitReply(reply);
        return (await nativeMessages()).find(({ info, parts }) =>
          info.role === "user" && parts.some((part) => part.text === text)
        )!.info.id;
      };
      const historical = await send(
        "Historical tool prompt",
        "Historical tool reply",
        true,
      );
      let lastPrompt = "";
      for (let i = 0; i < 8; i++) {
        lastPrompt = await send(`Later prompt ${i}`, `Later reply ${i}`);
      }
      const socket = await wire(page);
      let documents = 0;
      page.on("request", (request) => {
        if (request.resourceType() === "document") {
          documents++;
        }
      });
      await page.setViewportSize({ width: 1280, height: 680 });
      await openSession(state, page, session.id);
      const article =
        `[data-virtual-key="reply:${historical}"] [data-role="assistant"]`;
      const selector = `${article} .otk-work-fold`;
      const button = page.locator(selector);
      const count = () =>
        page.locator(".otk-message-flow").getAttribute("data-message-count")
          .then(Number);
      const older = page.getByRole("button", {
        name: "Load older messages",
        exact: true,
      });
      const historyPublished = () =>
        page.evaluate((promptID) => {
          const messages = (globalThis as typeof globalThis & {
            transcriptPublication: Map<string, import("@otk/protocol").Message>;
          }).transcriptPublication;
          return [...messages.values()].some((message) =>
            message.role === "assistant" && message.replyTo === promptID &&
            message.parts.some((part) =>
              part.kind === "tool" && part.call.tool === "bash"
            )
          );
        }, historical);
      // Native bookkeeping counts towards the page size, so a row count is
      // not evidence that the historical tool has reached the browser.
      while (!await historyPublished()) {
        await scrollTranscript(page, false);
        if (await older.isVisible()) {
          const previous = await count();
          await older.click();
          await expect.poll(count).toBeGreaterThan(previous);
        } else {
          await expect.poll(historyPublished).toBe(true);
        }
      }
      await revealAcquired(page, selector);
      await wheelTranscript(page, -1, button);
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect.poll(() =>
        socket.sent.filter(({ frame }) =>
          frame.method === "session.messages" && frame.params?.before
        ).length
      ).toBeGreaterThanOrEqual(2);
      const sample = (keep = false) =>
        page.evaluate(async ({ article, keep }) => {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          );
          const pane = document.querySelector<HTMLElement>(".otk-messages")!;
          const bounds = pane.getBoundingClientRect();
          const rows = Array.from(
            pane.querySelectorAll<HTMLElement>("[data-virtual-key]"),
          );
          const anchor = rows.filter((row) => {
            const box = row.getBoundingClientRect();
            return box.bottom > bounds.top && box.top < bounds.bottom;
          }).sort((a, b) =>
            a.getBoundingClientRect().top - b.getBoundingClientRect().top
          )[0];
          const candidate = document.querySelector(article);
          const body = Array.from(
            candidate?.querySelectorAll(".otk-text") ?? [],
          )
            .find((e) => e.textContent === "Historical tool reply");
          const text = body?.firstChild;
          const fold = candidate?.querySelector(".otk-work-fold");
          const memory = globalThis as typeof globalThis & {
            reconcileNodes?: {
              anchor?: Element;
              text?: Node | null;
              fold?: Element | null;
            };
          };
          if (keep) memory.reconcileNodes = { anchor, text, fold };
          const saved = memory.reconcileNodes!;
          return {
            anchor: anchor?.dataset.virtualKey,
            offset: anchor
              ? anchor.getBoundingClientRect().top - bounds.top
              : null,
            sameAnchor: !!anchor && anchor === saved.anchor &&
              anchor.isConnected,
            sameText: !!text && text === saved.text && text.isConnected,
            sameFold: !!fold && fold === saved.fold && fold.isConnected,
            expanded: fold?.getAttribute("aria-expanded"),
            offBottom:
              pane.scrollHeight - pane.clientHeight - pane.scrollTop > 1,
          };
        }, { article, keep });
      const beforeCount = await count();
      const wireRows = () => {
        const rows = new Map<string, string>();
        type Row = { id: string; role: string };
        type Op = { message?: Row };
        type Boundary = { items?: Row[]; catchup?: { event: Op }[] };
        for (const frame of socket.received) {
          const boundary =
            (frame.data as { page?: Boundary } | undefined)?.page ??
              (frame.outcome as { result?: Boundary } | undefined)?.result;
          if (Array.isArray(boundary?.items)) {
            for (const row of boundary.items) {
              if (row.id && row.role) {
                rows.set(row.id, row.role);
              }
            }
            for (const { event } of boundary.catchup ?? []) {
              if (event.message) rows.set(event.message.id, event.message.role);
            }
          }
          const event = frame.event as Op | undefined;
          if (event?.message) rows.set(event.message.id, event.message.role);
        }
        return rows;
      };
      const beforeWire = wireRows();
      const before = await sample(true);
      expect(before).toMatchObject({
        sameAnchor: true,
        sameText: true,
        sameFold: true,
        expanded: "true",
        offBottom: true,
      });
      expect(beforeCount).toBeGreaterThan(20);
      const startingInstance =
        (socket.received.find((f) => f.t === "welcome")!.sidecar as {
          instance: string;
        }).instance;
      const frameKey = (frame: Frame) =>
        frame.ref?.key ?? (frame.request as { key?: string } | undefined)?.key;
      const olderFrame = (frame: Frame, request?: Frame) => {
        const source = request ?? socket.sent.find(({ frame: sent }) =>
          sent.ref?.key && sent.ref.key === frameKey(frame)
        )?.frame;
        return source?.method === "session.messages" && !!source.params?.before;
      };
      const received = socket.received.length;
      const sent = socket.sent.length;
      const prompt = "During recovery prompt";
      const reply = "During recovery reply";
      const draft = "Keep this draft through reconnect";
      const input = page.locator("textarea[name=prompt]");
      const sendButton = page.getByRole("button", {
        name: "Send",
        exact: true,
      });
      const userRow = page.locator('[data-role="user"]').filter({
        has: page.getByText(prompt, { exact: true }),
      });
      const sameSendRow = (keep: boolean) =>
        userRow.evaluate((row, keep) => {
          const saved = globalThis as typeof globalThis & {
            reconcileSendRow?: Element;
          };
          if (keep) saved.reconcileSendRow = row;
          return row.isConnected && row === saved.reconcileSendRow;
        }, keep);
      let dropped = false;
      let pendingGate: string | undefined;
      if (trigger === "missing-frame") {
        socket.hold((frame, request) => {
          if (
            !dropped && frame.t === "content" &&
            frame.sessionID === session.id &&
            (frame.event as { op: string }).op === "message.upsert"
          ) {
            dropped = true;
            return true;
          }
          return olderFrame(frame, request);
        });
        await send(prompt, reply);
        expect(dropped).toBe(true);
        socket.held.splice(
          socket.held.findIndex(({ frame }) => frame.t === "content"),
          1,
        );
      } else {
        if (trigger === "pending-send") {
          await scrollTranscript(page, true);
          const { gate } = await state.queue([reply], "held");
          pendingGate = gate;
          socket.hold((frame, request) =>
            frame.t === "content" && frame.sessionID === session.id ||
            frame.t === "request.result" && request?.method === "session.prompt"
          );
          await input.fill(prompt);
          await sendButton.click();
          await expect.poll(() =>
            socket.held.some(({ request }) =>
              request?.method === "session.prompt"
            )
          ).toBe(true);
          await expect(userRow).toHaveCount(1);
          expect(await sameSendRow(true)).toBe(true);
          // Discard the old socket's frames. Existing request custody replays its
          // admitted intent on reconnect, not a second Composer send.
          socket.held.splice(0);
        }
        let welcome = false;
        socket.hold((frame, request) =>
          (welcome ||= frame.t === "welcome") || olderFrame(frame, request)
        );
        if (trigger === "restart-changed-head") {
          await state.controller.call("restart", {
            lease: state.lease.lease,
            target: "sidecar",
          });
        } else socket.close();
        await expect.poll(() => welcome, { timeout: 30_000 }).toBe(true);
        const instance = (socket.held.find(({ frame }) =>
          frame.t === "welcome"
        )!.frame.sidecar as { instance: string }).instance;
        if (trigger === "restart-changed-head") {
          expect(instance).not.toBe(startingInstance);
        } else expect(instance).toBe(startingInstance);
        if (trigger === "deletion") {
          await state.native(`/session/${session.id}/revert`, "POST", {
            messageID: lastPrompt,
            files: false,
          });
          // Native revert is recoverable until the next turn commits the cutoff.
          // Exercise closed coverage of real deletions, not the detached preview.
          await send("First prompt after revert", "First reply after revert");
          expect(
            (await nativeMessages()).some(({ info }) => info.id === lastPrompt),
          ).toBe(false);
        } else if (trigger === "pending-send") {
          await input.fill(draft);
          await expect(sendButton).toBeDisabled();
          await expect(input).toHaveValue(draft);
          await state.release(pendingGate!);
          await waitReply(reply);
        } else await send(prompt, reply);
        socket.release();
        socket.hold(olderFrame);
      }
      const head = () =>
        socket.sent.slice(sent).find(({ frame }) =>
          frame.method === "session.messages" && !frame.params?.before
        )?.frame;
      await expect.poll(() => !!head(), { timeout: 30_000 }).toBe(true);
      if (trigger !== "deletion" && trigger !== "pending-send") {
        await expect.poll(
          () =>
            socket.received.slice(received).some((f) =>
              frameKey(f) === head()?.ref?.key &&
              JSON.stringify(f).includes(reply)
            ),
          { timeout: 30_000 },
        ).toBe(true);
      }
      if (trigger === "pending-send") {
        await waitReply(reply);
        await expect(sendButton).toBeEnabled();
        await expect(input).toHaveValue(draft);
      }
      const after = await sample();
      console.log(
        "RECONCILE",
        JSON.stringify({ trigger, before, after, count: await count() }),
      );
      await info.attach("reconcile-anchor", {
        body: JSON.stringify({ before, after }),
        contentType: "application/json",
      });
      if (trigger !== "pending-send") {
        expect(after).toMatchObject({
          anchor: before.anchor,
          sameText: true,
          sameFold: true,
          expanded: "true",
        });
        expect(Math.abs(after.offset! - before.offset!)).toBeLessThanOrEqual(1);
      }
      if (trigger !== "missing-frame") {
        socket.release();
      }
      await scrollTranscript(page, true);
      if (trigger === "deletion") {
        await expect(page.getByText("Later prompt 7", { exact: true }))
          .toHaveCount(0);
        await expect(page.getByText("Later reply 7", { exact: true }))
          .toHaveCount(0);
      } else {
        const replyText = page.locator('[data-role="assistant"]').getByText(
          reply,
          { exact: true },
        );
        await expect(userRow).toHaveCount(1);
        await expect(replyText).toHaveCount(1);
        const native = await nativeMessages();
        const sent = native.filter(({ info, parts }) =>
          info.role === "user" && parts.some(({ text }) => text === prompt)
        );
        expect(sent).toHaveLength(1);
        // V2 emits explicit context rows not returned by native /message.
        // Require exactly two new conversational rows, and account for every
        // additional projected row by its distinct context identity on the wire.
        await expect.poll(() =>
          [...wireRows()].filter(([id, role]) =>
            !beforeWire.has(id) && role !== "context"
          ).length
        ).toBe(2);
        await expect.poll(async () => {
          const added = [...wireRows()].filter(([id]) => !beforeWire.has(id));
          return (await count()) - added.length;
        }).toBe(beforeCount);
        if (trigger === "pending-send") {
          await expect(userRow).toHaveAttribute(
            "data-message",
            sent[0].info.id,
          );
          expect(await sameSendRow(false)).toBe(true);
          const visual = await replyText.boundingBox();
          expect(visual!.y).toBeGreaterThan((await userRow.boundingBox())!.y);
        }
        await expect(page.getByText(/recover (your |the )?draft/i)).toHaveCount(
          0,
        );
      }
      expect(documents).toBe(1);
    },
  );
}
