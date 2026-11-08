// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, type Element, useContext } from "solid-js";

const Context = createContext<() => boolean>(() => false);
/** The composer owner supplies availability to its attention descendants. */
export function ComposerProvider(props: {
  available(): boolean;
  children: Element;
}): Element {
  return <Context value={props.available}>{props.children}</Context>;
}
export function useComposer(): () => boolean {
  return useContext(Context);
}
