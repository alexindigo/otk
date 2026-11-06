// SPDX-License-Identifier: LGPL-3.0-only
/** Indexed heap: changed keys are repaired at admission, never scanned per tick. */
export class ReadyQueue<T extends object> {
  #heap: T[] = [];
  #positions = new Map<T, number>();
  constructor(readonly before: (a: T, b: T) => boolean) {}
  peek(): T | undefined {
    return this.#heap[0];
  }
  add(value: T): void {
    this.delete(value);
    this.#positions.set(value, this.#heap.length);
    this.#heap.push(value);
    this.#up(this.#heap.length - 1);
  }
  delete(value: T): void {
    const position = this.#positions.get(value);
    if (position === undefined) return;
    this.#positions.delete(value);
    const last = this.#heap.pop()!;
    if (position === this.#heap.length) return;
    this.#heap[position] = last;
    this.#positions.set(last, position);
    this.#down(this.#up(position));
  }
  #swap(a: number, b: number): void {
    [this.#heap[a], this.#heap[b]] = [this.#heap[b], this.#heap[a]];
    this.#positions.set(this.#heap[a], a);
    this.#positions.set(this.#heap[b], b);
  }
  #up(position: number): number {
    while (position > 0) {
      const parent = (position - 1) >>> 1;
      if (!this.before(this.#heap[position], this.#heap[parent])) break;
      this.#swap(position, parent);
      position = parent;
    }
    return position;
  }
  #down(position: number): void {
    for (;;) {
      const left = position * 2 + 1, right = left + 1;
      let next = position;
      if (
        left < this.#heap.length &&
        this.before(this.#heap[left], this.#heap[next])
      ) next = left;
      if (
        right < this.#heap.length &&
        this.before(this.#heap[right], this.#heap[next])
      ) next = right;
      if (next === position) return;
      this.#swap(position, next);
      position = next;
    }
  }
}
