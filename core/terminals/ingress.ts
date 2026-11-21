// SPDX-License-Identifier: LGPL-3.0-only
export const TERMINAL_INPUT_MAX = 64 * 1024;
export const TERMINAL_SOCKET_HIGH = 1024 * 1024;
export class TerminalIngressOverload extends Error {}

/** Every retained lifetime consumes wire bytes, including its framing. */
export class TerminalIngress {
  #bytes = 0;
  admit(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 1) {
      throw new RangeError("Ingress requires a nonempty framed message");
    }
    if (this.#bytes + bytes > TERMINAL_SOCKET_HIGH) {
      throw new TerminalIngressOverload("Terminal ingress window is full");
    }
    this.#bytes += bytes;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#bytes -= bytes;
    };
  }
}
