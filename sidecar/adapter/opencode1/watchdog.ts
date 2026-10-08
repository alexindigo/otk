// SPDX-License-Identifier: LGPL-3.0-only
export class Watchdog {
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly milliseconds: number, readonly expired: () => void) {}
  touch(): void {
    this.stop();
    this.#timer = setTimeout(this.expired, this.milliseconds);
  }
  stop(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
export class Backoff {
  #seconds = 1;
  constructor(readonly maximum: number) {}
  connected(): void {
    this.#seconds = 1;
  }
  next(): number {
    const delay = this.#seconds;
    this.#seconds = Math.min(this.maximum, this.#seconds * 2);
    return delay * 1000;
  }
}
