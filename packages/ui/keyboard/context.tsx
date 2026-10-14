// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, type Element, onSettled, useContext } from "solid-js";
import { type Command, CommandHub } from "@otk/client";
import type { Keyboard } from "./dispatcher.ts";
export interface CommandPorts {
  commands: CommandHub;
  keyboard?: Keyboard;
}
// Solid 2 throws for an unset context. Null explicitly marks isolated controls.
const Context = createContext<CommandPorts | null>(null);
export function CommandProvider(
  props: CommandPorts & { children: Element },
): Element {
  return <Context value={props}>{props.children}</Context>;
}
export function useCommandPorts(): CommandPorts {
  return useContext(Context) ?? { commands: new CommandHub() };
}
/** Owner registers closures, exposes only ID invocation, releases on unmount. */
export function ownedCommand<A = void, R = void>(
  ports: CommandPorts,
  command: Command<A, R>,
): (args: A) => Promise<R> {
  let mounted = false;
  onSettled(() => {
    const release = ports.commands.register(command);
    mounted = true;
    return () => {
      mounted = false;
      release();
    };
  });
  return (args) =>
    mounted
      ? ports.commands.run<R>(command.id, args)
      : Promise.reject(new Error(`Command owner inactive: ${command.id}`));
}
/** Independently mountable controls get isolated, owner-scoped action IDs. */
export function ownedAction<A = void, R = void>(
  name: string,
  run: (args: A) => R | Promise<R>,
): (args: A) => Promise<R> {
  return ownedCommand(useCommandPorts(), {
    id: `${name}:${crypto.randomUUID()}`,
    title: name,
    category: "Controls",
    hidden: true,
    run: (_ctx, args: A) => run(args),
  });
}
