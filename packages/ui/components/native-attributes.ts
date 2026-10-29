// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, createSignal, onCleanup } from "solid-js";

const eventKey = (key: PropertyKey): key is string =>
  typeof key === "string" && key.startsWith("on") && key.length > 2 &&
  !key.includes(":");

/** Native spreads/dynamic tags bypass compiler event policy. Own their listeners
 * at the DOM edge instead of installing source-retaining delegated event getters. */
export function nativeAttributes<T extends object>(read: () => T) {
  const [element, setElement] = createSignal<HTMLElement>();
  let release = () => {};
  const visible = (key: PropertyKey) =>
    typeof key === "string" && key !== "ref" && !eventKey(key);
  const attributes = new Proxy({} as T, {
    ownKeys: () => Reflect.ownKeys(read()).filter(visible),
    has: (_, key) => visible(key) && Reflect.has(read(), key),
    get: (_, key) => visible(key) ? Reflect.get(read(), key) : undefined,
    getOwnPropertyDescriptor: (_, key) =>
      visible(key) && Reflect.has(read(), key)
        ? { configurable: true, enumerable: true }
        : undefined,
  });
  createEffect(() => {
    const props = read();
    return {
      element: element(),
      handlers: Object.keys(props).filter(eventKey).map((
        key,
      ): [string, unknown] => [
        key.slice(2).toLowerCase(),
        Reflect.get(props, key),
      ]),
    };
  }, ({ element, handlers }) => {
    release();
    const removals: (() => void)[] = [];
    release = () => {
      for (const remove of removals) remove();
    };
    if (!element) return;
    for (const [name, handler] of handlers) {
      if (!handler) continue;
      if (name === "contextmenu") {
        throw new TypeError(
          "Context menus belong to the shared ContextMenu owner",
        );
      }
      const listener: EventListenerOrEventListenerObject =
        Array.isArray(handler)
          ? (event) => handler[0].call(element, handler[1], event)
          : handler as EventListenerOrEventListenerObject;
      const options = typeof listener === "object"
        ? listener as AddEventListenerOptions
        : undefined;
      element.addEventListener(name, listener, options);
      removals.push(() => element.removeEventListener(name, listener, options));
    }
  });
  onCleanup(() => release());
  return {
    attributes,
    ref: (element: HTMLElement) => {
      setElement(element);
    },
  };
}
