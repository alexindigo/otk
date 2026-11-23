// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, type Element, onSettled, useContext } from "solid-js";
import type { Reload, ReloadOwner } from "@otk/client";
const Context = createContext<Reload | null>(null);
export function ReloadProvider(
  props: { owner?: Reload; children: Element },
): Element {
  return <Context value={props.owner ?? null}>{props.children}</Context>;
}
/** A feature contributes its own unsaved state, without consumer DOM inspection. */
export function retainForReload(key: string, owner: ReloadOwner): void {
  const reload = useContext(Context);
  if (reload) onSettled(() => reload.register(key, owner));
}
