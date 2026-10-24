// SPDX-License-Identifier: LGPL-3.0-only
import {
  createContext,
  createSignal,
  type Element,
  onSettled,
  useContext,
} from "solid-js";
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
/** Current shortcut presentation, including bindings for hidden commands. */
export function commandHints(ports: CommandPorts): {
  keys(id: string): string;
  title(id: string, label: string): string;
} {
  const [revision, setRevision] = createSignal(0);
  onSettled(() => {
    const invalidate = () => setRevision((value) => value + 1);
    const stopKeys = ports.keyboard?.keymap.subscribe(invalidate);
    const stopCommands = ports.commands.subscribe(invalidate);
    invalidate();
    return () => {
      stopKeys?.();
      stopCommands();
    };
  });
  const keys = (id: string) => {
    revision();
    const values = ports.keyboard
      ? ports.keyboard.keymap.list().filter((row) => row.command === id).map((
        row,
      ) => row.key)
      : ports.commands.keys(id);
    return [...new Set(values.filter(Boolean))].map((key) =>
      key.split("+").map((part) => part === "Escape" ? "Esc" : part).join("+")
    ).join(" / ");
  };
  return {
    keys,
    title: (id: string, label: string) => {
      const hint = keys(id);
      return hint ? `${label} (${hint})` : label;
    },
  };
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
  options: Pick<Command<A, R>, "context" | "enabled"> = {},
): (args: A) => Promise<R> {
  return ownedCommand(useCommandPorts(), {
    id: `${name}:${crypto.randomUUID()}`,
    title: name,
    category: "Controls",
    hidden: true,
    ...options,
    run: (_ctx, args: A) => run(args),
  });
}
