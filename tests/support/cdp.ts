// SPDX-License-Identifier: LGPL-3.0-only
// Adapted from kosmozoo/tests/e2e/cdp.cjs: raw CDP, no browser npm dependency.
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "@std/path";
import { freePort, waitFor } from "./opencode.ts";

type Json = Record<string, unknown>;
export class Cdp {
  #socket!: WebSocket;
  #child!: ChildProcess;
  #next = 0;
  #pending = new Map<number, {
    resolve: (value: Json) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  events: { method: string; params: Json }[] = [];
  errors: unknown[] = [];

  static async launch(root: string): Promise<Cdp> {
    const cdp = new Cdp(), port = freePort();
    cdp.#child = spawn("/usr/bin/chromium", [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,800",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(root, "chromium-" + port)}`,
      "about:blank",
    ], { stdio: "ignore" });
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
      await new Promise<void>((resolve, reject) => {
        cdp.#socket.onopen = () => resolve();
        cdp.#socket.onerror = () => reject(new Error("CDP connection failed"));
      });
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
  }
  send(method: string, params: Json = {}): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }));
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
  async poll(expression: string, timeout = 30_000): Promise<unknown> {
    return await waitFor(
      () => this.evaluate(expression),
      (value) => !!value,
      timeout,
    );
  }
  async click(selector: string): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number }>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Missing click target');
      el.scrollIntoView({block:'center',inline:'nearest'});
      const r = el.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        ...point,
        button: "left",
        clickCount: 1,
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
    if (this.#socket?.readyState === WebSocket.OPEN) {
      try {
        await this.send("Browser.close");
      } catch { /* Browser already closed. */ }
    }
    this.#socket?.close();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP closed"));
    }
    this.#pending.clear();
    if (
      this.#child?.pid && this.#child.exitCode === null &&
      this.#child.signalCode === null
    ) {
      const exited = new Promise<void>((resolve) =>
        this.#child.once("exit", () => resolve())
      );
      this.#child.kill("SIGTERM");
      await exited;
    }
  }
}
