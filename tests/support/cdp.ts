// SPDX-License-Identifier: LGPL-3.0-only
// Adapted from kosmozoo/tests/e2e/cdp.cjs: raw CDP, no browser npm dependency.
import { join } from "@std/path";
import { freePort, waitFor } from "./opencode.ts";
import { acquire, bounded, resources } from "./resources.ts";
import { ownedProcess } from "./process.ts";

type Json = Record<string, unknown>;
export class Cdp {
  #socket!: WebSocket;
  #stop: () => Promise<void> = () => Promise.resolve();
  #closing?: Promise<void>;
  #next = 0;
  #pending = new Map<number, {
    resolve: (value: Json) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  events: { method: string; params: Json }[] = [];
  errors: unknown[] = [];

  static async launch(root: string): Promise<Cdp> {
    return await acquire("Chromium fixture", async () => {
      const cdp = new Cdp(), port = freePort();
      const tmp = join(root, `chromium-tmp-${port}`);
      await Deno.mkdir(tmp);
      const owner = ownedProcess("/usr/bin/chromium", [
        "--headless=new",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1280,800",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${join(root, "chromium-" + port)}`,
        "about:blank",
      ], { stdio: "ignore", env: { ...Deno.env.toObject(), TMPDIR: tmp } });
      cdp.#stop = owner.stop;
      resources().defer("CDP transport", () => cdp.close());
      try {
        const target = await waitFor(async () => {
          const list: { type: string; webSocketDebuggerUrl: string }[] = await (
            await fetch(`http://127.0.0.1:${port}/json/list`, {
              signal: AbortSignal.timeout(2000),
            })
          ).json();
          return list.find((item) => item.type === "page");
        }, (target) => !!target);
        cdp.#socket = new WebSocket(target!.webSocketDebuggerUrl);
        await bounded(
          "CDP open",
          new Promise<void>((resolve, reject) => {
            cdp.#socket.onopen = () => resolve();
            cdp.#socket.onerror = () =>
              reject(new Error("CDP connection failed"));
            cdp.#socket.onclose = () =>
              reject(new Error("CDP closed before open"));
          }),
        );
        cdp.#socket.onclose = () =>
          cdp.#rejectPending(new Error("CDP transport closed"));
        cdp.#socket.onerror = () =>
          cdp.#rejectPending(new Error("CDP transport failed"));
        cdp.#socket.onmessage = ({ data }) => {
          const message = JSON.parse(data);
          if (message.method) {
            cdp.events.push(message);
            if (message.method === "Runtime.exceptionThrown") {
              cdp.errors.push(message.params.exceptionDetails);
            }
          }
          const pending = cdp.#pending.get(message.id);
          if (pending) {
            clearTimeout(pending.timer);
            cdp.#pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result);
          }
        };
        await cdp.send("Runtime.enable");
        await cdp.send("Page.enable");
        await cdp.send("Network.enable");
        return cdp;
      } catch (error) {
        await cdp.close();
        throw error;
      }
    });
  }
  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
  send(method: string, params: Json = {}): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return (result.result as { value: T }).value;
  }
  async goto(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    await this.poll("document.readyState !== 'loading'");
  }
  async reload(): Promise<void> {
    const navigations = () =>
      this.events.filter((event) => event.method === "Page.frameNavigated")
        .length;
    const before = navigations();
    await this.send("Page.reload");
    await waitFor(navigations, (count) => count > before);
    await this.poll("document.readyState !== 'loading'");
  }
  async poll(expression: string, timeout = 30_000): Promise<unknown> {
    return await waitFor(
      () => this.evaluate(expression),
      (value) => !!value,
      timeout,
    );
  }
  async click(selector: string, clickCount = 1): Promise<void> {
    // DOM presence is not pointer readiness: pending render/scroll frames can
    // invalidate a measured point before input arrives. Observe stable rendered
    // geometry and hit-testing before sending a single native gesture.
    const point = await waitFor(
      () =>
        this.evaluate<false | { x: number; y: number }>(`(async () => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el || el.matches(':disabled')) return false;
          el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
          let r = el.getBoundingClientRect();
          for (let frame = 0; frame < 2; frame++) {
            await new Promise(requestAnimationFrame);
            const next = el.getBoundingClientRect();
            if (r.x !== next.x || r.y !== next.y ||
                r.width !== next.width || r.height !== next.height) return false;
            r = next;
          }
          if (!el.isConnected || el !== document.querySelector(${
          JSON.stringify(selector)
        }) || el.matches(':disabled') || !r.width || !r.height) return false;
          const point = {x:r.x+r.width/2,y:r.y+r.height/2};
          const hit = document.elementFromPoint(point.x, point.y);
          return hit && el.contains(hit) ? point : false;
        })()`),
      (point) => !!point,
    );
    if (!point) throw new Error(`Click target not ready: ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount,
        buttons: type === "mousePressed" ? 1 : 0,
      });
    }
  }
  async key(key: string, modifiers = 0): Promise<void> {
    const special: Record<string, number> = {
      Enter: 13,
      Escape: 27,
      ArrowUp: 38,
      ArrowDown: 40,
      Tab: 9,
    };
    const code = key.length === 1 && /[a-z]/i.test(key)
      ? `Key${key.toUpperCase()}`
      : key;
    const vk = special[key] ??
      (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    for (const type of ["keyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", {
        type,
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
      });
    }
  }
  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.send("Input.insertText", { text });
  }
  async fill(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.key("a", 2);
    await this.send("Input.insertText", { text });
  }
  async dialog(action: () => Promise<unknown>, accept: boolean): Promise<void> {
    const before =
      this.events.filter((event) =>
        event.method === "Page.javascriptDialogOpening"
      ).length;
    // A modal can hold the triggering command's reply. Handle it in parallel.
    const triggered = action().then(() => undefined, (error: unknown) => error);
    await waitFor(
      () =>
        this.events.filter((event) =>
          event.method === "Page.javascriptDialogOpening"
        ).length,
      (count) => count > before,
    );
    await this.send("Page.handleJavaScriptDialog", { accept });
    const error = await triggered;
    if (error) throw error;
  }
  async dismissDialog(): Promise<void> {
    const last = this.events.findLast((event) =>
      event.method === "Page.javascriptDialogOpening" ||
      event.method === "Page.javascriptDialogClosed"
    );
    if (last?.method === "Page.javascriptDialogOpening") {
      await this.send("Page.handleJavaScriptDialog", { accept: false });
    }
  }
  async screenshot(path: string): Promise<void> {
    const result = await this.send("Page.captureScreenshot", { format: "png" });
    const bytes = Uint8Array.from(
      atob(result.data as string),
      (c) => c.charCodeAt(0),
    );
    await Deno.writeFile(path, bytes);
  }
  async close(): Promise<void> {
    await (this.#closing ??= (async () => {
      this.#rejectPending(new Error("CDP closed"));
      const socket = this.#socket;
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        const closed = new Promise<void>((resolve) =>
          socket.addEventListener("close", () => resolve(), { once: true })
        );
        socket.close();
        await this.#stop();
        await bounded("CDP socket close", closed, 2000);
      } else await this.#stop();
    })());
  }
}
