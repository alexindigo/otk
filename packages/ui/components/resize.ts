// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onCleanup } from "solid-js";
/** One immutable gesture origin: borders and the grab point cannot change size.
 * Owners persist the invocation's final coordinate, not a previous painted read. */
export function resizeDrag(
  width: number,
  pointer: number,
  direction: 1 | -1,
  min: number,
  max: number,
): (current: number) => number {
  return (current) =>
    Math.max(min, Math.min(max, width + (current - pointer) * direction));
}

type Pointer = PointerEvent & { currentTarget: HTMLElement };
const KEY_STEP = 8;
export interface ResizeBinding {
  width(): number;
  handlers: {
    onKeyDown(event: KeyboardEvent): void;
    onPointerDown(event: Pointer): void;
    onPointerMove(event: Pointer): void;
    onPointerUp(event: Pointer): void;
    onPointerCancel(event: Pointer): void;
    onLostPointerCapture(event: Pointer): void;
  };
}

/** Native gesture lifetime shared by both columns; the consumer supplies only
 * its direction, policy and authoritative persistence port. */
export function createResize(options: {
  width(): number;
  ready(): boolean;
  direction: 1 | -1;
  bounds: { min: number; max: number };
  save(width: number): Promise<void>;
  fail(error: unknown): void;
}): ResizeBinding {
  const [revision, setRevision] = createSignal(0);
  let transient: number | undefined;
  const setTransient = (value: number | undefined) => {
    transient = value;
    setRevision((revision) => revision + 1);
  };
  const width = () => {
    revision();
    return transient ?? options.width();
  };
  type Gesture = {
    pointer?: number;
    target?: HTMLElement;
    move?: (x: number) => number;
  };
  let current: Gesture | undefined, alive = true;
  const release = (gesture: Gesture) => {
    const pointer = gesture.pointer;
    gesture.pointer = undefined;
    if (pointer !== undefined && gesture.target?.hasPointerCapture(pointer)) {
      gesture.target.releasePointerCapture(pointer);
    }
  };
  const cancel = () => {
    const gesture = current;
    current = undefined;
    if (gesture) release(gesture);
    setTransient(undefined);
  };
  onCleanup(() => {
    alive = false;
    cancel();
  });
  const persist = async (gesture: Gesture, value: number) => {
    setTransient(value);
    try {
      await options.save(value);
    } catch (error) {
      if (alive) options.fail(error);
    } finally {
      if (alive && current === gesture) {
        current = undefined;
        setTransient(undefined);
      }
    }
  };
  const captured = (event: Pointer) =>
    current?.pointer === event.pointerId &&
    current.target === event.currentTarget &&
    event.currentTarget.hasPointerCapture(event.pointerId);
  return {
    width,
    handlers: {
      onKeyDown(event: KeyboardEvent) {
        if (
          !options.ready() || current?.pointer !== undefined ||
          !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
        ) return;
        event.preventDefault();
        const { min, max } = options.bounds;
        const next = event.key === "Home"
          ? min
          : event.key === "End"
          ? max
          : Math.max(
            min,
            Math.min(
              max,
              width() +
                (event.key === "ArrowRight" ? KEY_STEP : -KEY_STEP) *
                  options.direction,
            ),
          );
        const gesture: Gesture = {};
        current = gesture;
        void persist(gesture, next);
      },
      onPointerDown(event: Pointer) {
        if (
          !options.ready() || current?.pointer !== undefined ||
          event.button !== 0
        ) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        current = {
          pointer: event.pointerId,
          target: event.currentTarget,
          move: resizeDrag(
            width(),
            event.clientX,
            options.direction,
            options.bounds.min,
            options.bounds.max,
          ),
        };
        setTransient(width());
      },
      onPointerMove(event: Pointer) {
        if (!captured(event)) return;
        if (!options.ready()) {
          cancel();
          return;
        }
        setTransient(current!.move!(event.clientX));
      },
      onPointerUp(event: Pointer) {
        if (!captured(event)) return;
        if (!options.ready()) {
          cancel();
          return;
        }
        const gesture = current!, value = gesture.move!(event.clientX);
        release(gesture);
        void persist(gesture, value);
      },
      onPointerCancel(event: Pointer) {
        if (current?.pointer === event.pointerId) cancel();
      },
      onLostPointerCapture(event: Pointer) {
        if (current?.pointer === event.pointerId) cancel();
      },
    },
  };
}
