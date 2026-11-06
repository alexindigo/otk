// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import type { TestState } from "./test-state.ts";

export interface Frame {
  t: string;
  method?: string;
  ref?: { key: string };
  params?: { sessionID?: string; [key: string]: unknown };
  sessionID?: string;
  [key: string]: unknown;
}
/** Observe and delay real frames; release preserves their original bytes/order. */
export async function wire(
  page: Page,
  outgoing: (frame: Frame) => Frame = (frame) => frame,
) {
  const sent: { frame: Frame; time: number }[] = [], received: Frame[] = [];
  const requests = new Map<string, Frame>();
  const sockets: WebSocketRoute[] = [];
  const held: { frame: Frame; request?: Frame; deliver(): void }[] = [];
  let predicate = (_frame: Frame, _request?: Frame) => false;
  let opened = 0, closed = 0;
  await page.routeWebSocket("**/ws", (socket) => {
    let didClose = false;
    sockets.push(socket);
    opened++;
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as Frame;
      sent.push({ frame, time: performance.now() });
      if (frame.t === "request") requests.set(frame.ref!.key, frame);
      server.send(JSON.stringify(outgoing(frame)));
    });
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as Frame;
      received.push(frame);
      const request = requests.get(frame.ref?.key ?? "");
      if (predicate(frame, request)) {
        held.push({
          frame,
          request,
          deliver: () => socket.send(message),
        });
      } else socket.send(message);
    });
    socket.onClose(() => {
      if (didClose) return;
      didClose = true;
      closed++;
      server.close();
    });
    server.onClose(() => {
      if (!didClose) socket.close();
    });
  });
  return {
    sent,
    received,
    held,
    connections: () => ({ opened, closed }),
    hold(check: typeof predicate) {
      predicate = check;
    },
    release() {
      predicate = () => false;
      for (const frame of held.splice(0)) frame.deliver();
    },
    close() {
      sockets.at(-1)!.close();
    },
    fault(frame: Frame) {
      sockets.at(-1)!.send(JSON.stringify(frame));
    },
  };
}
export async function openSession(state: TestState, page: Page, id: string) {
  await state.product("layout.patch", {
    rightCollapsed: false,
    rightView: "sessions",
  });
  if (!page.url().startsWith(state.url)) {
    await page.goto(`${state.url}/#/local/${id}`);
  } else {
    if (!await page.locator(`[data-session="${id}"]`).count()) {
      const session = await state.product("session.get", { sessionID: id });
      await page.locator(
        `[data-server=local][data-project=${
          JSON.stringify(session.directory)
        }] .otk-project-open`,
      )
        .click();
    }
    await page.locator(`[data-session="${id}"]`).click();
  }
  await expect(page).toHaveURL(new RegExp(`${id}$`));
  await expect(page.locator("textarea[name=prompt]")).toBeAttached();
  await expect(page.getByRole("region", { name: "Transcript", exact: true }))
    .toHaveAttribute("aria-busy", "false");
}
/** Elapsed contract, never a readiness sleep: continuously inspect until the boundary. */
export async function throughDuration(
  ms: number,
  inspect: () => Promise<void>,
) {
  const start = performance.now();
  let failure: unknown;
  await expect.poll(async () => {
    try {
      await inspect();
    } catch (error) {
      failure = error;
    }
    return failure ? ms : performance.now() - start;
  }, { timeout: ms + 10_000, intervals: [100, 250, 500] })
    .toBeGreaterThanOrEqual(ms);
  if (failure) throw failure;
  return performance.now() - start;
}
