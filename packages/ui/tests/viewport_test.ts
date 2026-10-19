// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { followViewport } from "../components/viewport.ts";

/** Controlled native event/frame order; assertions observe viewport position. */
function viewportFixture(
  run: (f: {
    pane: HTMLElement;
    height(value: number): void;
    resize(): void;
    flush(): void;
  }) => void,
) {
  const names = [
    "document",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "ResizeObserver",
  ] as const;
  const saved = names.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name)
  );
  let next = 0, resize = () => {};
  const frames = new Map<number, FrameRequestCallback>();
  class Pane extends EventTarget {
    scrollHeight = 1000;
    clientHeight = 100;
    #top = 0;
    get scrollTop() {
      return Math.min(this.#top, this.scrollHeight - this.clientHeight);
    }
    set scrollTop(value: number) {
      this.#top = Math.max(
        0,
        Math.min(value, this.scrollHeight - this.clientHeight),
      );
    }
  }
  const pane = new Pane() as unknown as HTMLElement;
  const values = [
    new EventTarget(),
    (callback: FrameRequestCallback) => {
      const id = ++next;
      frames.set(id, callback);
      return id;
    },
    (id: number) => {
      frames.delete(id);
    },
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  ];
  names.forEach((name, i) =>
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: values[i],
    })
  );
  const owner = followViewport(pane, pane, () => {});
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };
  try {
    flush();
    assertEquals(pane.scrollTop, 900);
    run({
      pane,
      height: (value) => {
        (pane as unknown as Pane).scrollHeight = value;
      },
      resize: () => resize(),
      flush,
    });
  } finally {
    owner.dispose();
    names.forEach((name, i) => {
      if (saved[i]) Object.defineProperty(globalThis, name, saved[i]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}

Deno.test("explicit transcript position supersedes queued follow before or after its scroll notification", () => {
  for (const notify of [false, true]) {
    viewportFixture(({ pane, height, resize, flush }) => {
      // A genuine final layout change queues follow, then reveal moves the reader.
      height(1100);
      resize();
      pane.scrollTop = 200;
      if (notify) pane.dispatchEvent(new Event("scroll"));
      flush();
      assertEquals(pane.scrollTop, 200, `late scroll notification: ${!notify}`);
      // Programmatic movement preserves follow intent for subsequent new layout.
      height(1200);
      resize();
      flush();
      assertEquals(pane.scrollTop, 1100);
    });
  }
});

Deno.test("native geometry clamping is not a newer explicit transcript position", () => {
  viewportFixture(({ pane, height, resize, flush }) => {
    height(950);
    pane.dispatchEvent(new Event("scroll"));
    resize();
    flush();
    assertEquals(pane.scrollTop, 850);
    height(1100);
    resize();
    flush();
    assertEquals(pane.scrollTop, 1000);
  });
});
