// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, type Element, useContext } from "solid-js";
import type { PathSemantics } from "@otk/protocol";
const Context = createContext<(() => PathSemantics | undefined) | null>(null);
/** Data-only provider; independent consumers inject the originating machine's flavor. */
export function PathProvider(
  props: { paths?: PathSemantics; children: Element },
): Element {
  return (
    <Context value={() => props.paths}>
      {props.children}
    </Context>
  );
}
export const usePathSemantics = () => {
  const paths = useContext(Context);
  return () => paths?.();
};
