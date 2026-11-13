// SPDX-License-Identifier: LGPL-3.0-only
import {
  type CommandArguments,
  freezeCommandArguments,
  noCommandArguments,
  parseCommandArguments,
  validateCommandArguments,
} from "./command-arguments.ts";
export type { CommandArguments } from "./command-arguments.ts";
/** Invocation-time context supplied by the consumer, never browser globals. */
export interface CommandContext {
  sidecar?: string;
  session?: string;
  focus?: string;
  dialog?: string;
  /** Prevent reentrant text commands from invoking their own input owner. */
  command?: string;
}
/** Data-only owner metadata; discovery visibility does not hide key labels. */
export interface CommandMetadata {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly name?: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly arguments?: CommandArguments;
  readonly scope?: string;
  readonly instance?: string;
  readonly source?: "builtin" | "server" | "mcp" | "skill" | "unknown";
  /** Submissions participate in the prompt's captured send/clear lifecycle. */
  readonly kind?: "action" | "submission";
  /** An adapter contribution borrows the semantic owner's schema and behavior. */
  readonly action?: string;
  readonly priority?: number;
}
export type CommandAvailability = { available: true } | {
  available: false;
  reason: string;
};
export interface Command<A = unknown, R = unknown> extends CommandMetadata {
  /** Feature-owned context contribution; args are the target's captured data. */
  context?: {
    kind: string | readonly string[];
    title?(args: A): string;
    confirm?(args: A): string;
    /** One feature registration may project several invocation-specific choices. */
    items?(args: A): { key?: string; title: string; args: A }[];
    destructive?: boolean;
    order?: number;
  };
  enabled?(context: CommandContext, args?: A): boolean;
  availability?(context: CommandContext, args?: A): CommandAvailability;
  run(context: CommandContext, args: A): R | Promise<R>;
}
/** A typed input cannot be registered without its runtime contract. */
export type CommandDefinition<A = void, R = unknown> =
  & Command<A, R>
  & ([A] extends [void] ? unknown : { arguments: CommandArguments });
export interface ListedCommand {
  cmd: CommandMetadata;
  enabled: boolean;
  keys: string[];
  availability: CommandAvailability;
}
function commandMetadata(command: CommandMetadata): CommandMetadata {
  return Object.freeze({
    id: command.id,
    title: command.title,
    category: command.category,
    name: command.name ?? command.id,
    aliases: Object.freeze([...(command.aliases ?? [])]),
    description: command.description ?? command.title,
    arguments: command.arguments
      ? freezeCommandArguments(command.arguments)
      : noCommandArguments,
    scope: command.scope ?? "application",
    instance: command.instance,
    source: command.source ?? "builtin",
    kind: command.kind ?? "action",
    action: command.action,
    priority: command.priority,
  });
}
/** Empty, framework-free registry. Feature owners register and release behavior. */
export class CommandHub {
  #commands = new Map<string, Command>();
  #listeners = new Set<() => void>();
  #actions = new WeakMap<
    ContextAction,
    { command: Command; target: ContextTarget }
  >();
  constructor(
    readonly context: () => CommandContext = () => ({}),
    readonly keys: (id: string) => string[] = () => [],
    readonly confirm?: (message: string) => boolean | Promise<boolean>,
  ) {}
  register<A = void, R = unknown>(
    command: CommandDefinition<A, R>,
  ): () => void {
    if (!command.id || this.#commands.has(command.id)) {
      throw new Error(`Duplicate or empty command: ${command.id}`);
    }
    const visited = new Set([command.id]);
    let action = command.action;
    while (action) {
      if (visited.has(action)) {
        throw new Error(`Cyclic command binding: ${command.id}`);
      }
      visited.add(action);
      action = this.#commands.get(action)?.action;
    }
    const copy = Object.freeze({
      ...command,
      ...commandMetadata(command),
      context: command.context && Object.freeze({
        ...command.context,
        kind: typeof command.context.kind === "string"
          ? command.context.kind
          : Object.freeze([...command.context.kind]),
      }),
    });
    this.#commands.set(command.id, copy as Command);
    this.#changed();
    return () => {
      if (this.#commands.get(command.id) !== copy) return;
      this.#commands.delete(command.id);
      this.#changed();
    };
  }
  has(id: string): boolean {
    return this.#commands.has(id);
  }
  metadata(id: string): CommandMetadata | undefined {
    const command = this.#commands.get(id);
    if (!command) return;
    const metadata = commandMetadata(command);
    const target = command.action && this.metadata(command.action);
    return target
      ? Object.freeze({
        ...metadata,
        arguments: target.arguments,
        kind: target.kind ?? "action",
      })
      : metadata;
  }
  unregister(id: string): void {
    if (this.#commands.delete(id)) this.#changed();
  }
  enabled(
    id: string,
    context: CommandContext = this.context(),
    args?: unknown,
  ): boolean {
    const command = this.#commands.get(id);
    return !!command && this.availability(id, context, args).available;
  }
  availability(
    id: string,
    context: CommandContext = this.context(),
    args?: unknown,
  ): CommandAvailability {
    const command = this.#commands.get(id);
    if (!command) return { available: false, reason: "Command owner inactive" };
    if (context.command === command.id) {
      return {
        available: false,
        reason: "Command input is already being handled",
      };
    }
    try {
      validateCommandArguments(
        this.metadata(id)!.arguments ?? noCommandArguments,
        args,
      );
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error
          ? error.message
          : "Invalid command arguments",
      };
    }
    const available: CommandAvailability =
      command.availability?.(context, args) ??
        ((command.enabled?.(context, args) ?? true) ? { available: true } : {
          available: false,
          reason: "Command unavailable in the current context",
        });
    if (!available.available || !command.action) return available;
    return this.availability(command.action, context, args);
  }
  async run<R = void>(
    id: string,
    args?: unknown,
    context: CommandContext = this.context(),
  ): Promise<R> {
    return await this.#run<R>(id, args, context, false);
  }
  async #run<R>(
    id: string,
    args: unknown,
    context: CommandContext,
    confirmed: boolean,
  ): Promise<R> {
    const command = this.#commands.get(id);
    if (!command) throw new Error(`Unknown command: ${id}`);
    const availability = this.availability(id, context, args);
    if (!availability.available) {
      throw new Error(`Command unavailable: ${id}: ${availability.reason}`);
    }
    if (command.context?.confirm && !confirmed) {
      if (!this.confirm) throw new Error("Command confirmation is unavailable");
      if (!await this.confirm(command.context.confirm(args))) {
        throw new Error("Command cancelled");
      }
      if (this.#commands.get(id) !== command) {
        throw new Error("This action is no longer available.");
      }
      const current = this.availability(id, context, args);
      if (!current.available) {
        throw new Error(`Command unavailable: ${id}: ${current.reason}`);
      }
    }
    return command.action
      ? await this.#run<R>(command.action, args, context, confirmed)
      : await command.run(context, args) as R;
  }
  /** Projection refreshes share consent only while their contributor is identical. */
  sameContextOwner(left: ContextAction, right: ContextAction): boolean {
    const source = this.#actions.get(left);
    return !!source && source.command === this.#actions.get(right)?.command;
  }
  /** Context execution is bound to the contributing owner and current item list. */
  async runContext<R = void>(action: ContextAction): Promise<R> {
    const source = this.#actions.get(action);
    if (!source || this.#commands.get(action.id) !== source.command) {
      throw new Error("This action is no longer available.");
    }
    const current = this.contextActions(source.target).find((item) =>
      item.key === action.key
    );
    if (!current) throw new Error("This action is no longer available.");
    return await this.#run<R>(current.id, current.args, this.context(), true);
  }
  /** Data-only menu projection; execution always rechecks the ordinary command. */
  contextActions(target: ContextTarget): ContextAction[] {
    const context = this.context();
    return [...this.#commands.values()].filter((command) =>
      typeof command.context?.kind === "string"
        ? command.context.kind === target.kind
        : command.context?.kind.includes(target.kind)
    ).sort((a, b) =>
      Number(a.context?.destructive ?? false) -
        Number(b.context?.destructive ?? false) ||
      (a.context?.order ?? 0) - (b.context?.order ?? 0)
    ).flatMap((command) => {
      const items = command.context?.items?.(target.data) ??
        (command.context?.items ? [] : [{
          key: "",
          title: command.context?.title?.(target.data) ?? command.title,
          args: command.arguments?.type === "none" || !command.arguments
            ? undefined
            : target.data,
        }]);
      return items.filter((item) =>
        this.enabled(command.id, context, item.args)
      ).map((item) => {
        const confirm = command.context?.confirm?.(item.args);
        const action = {
          id: command.id,
          key: JSON.stringify([command.id, item.key ?? item.title]),
          title: item.title,
          args: item.args,
          destructive: command.context?.destructive ?? false,
          ...(confirm === undefined ? {} : { confirm }),
        };
        this.#actions.set(action, { command, target });
        return action;
      });
    });
  }
  list(context: CommandContext = this.context()): ListedCommand[] {
    return [...this.#commands.values()].map((cmd) => {
      const availability = this.availability(cmd.id, context);
      return {
        cmd: this.metadata(cmd.id)!,
        enabled: availability.available,
        availability,
        keys: this.keys(cmd.id),
      };
    });
  }
  resolveSlash(name: string): string | undefined {
    if (this.#commands.has(name)) return name;
    const matches = [...this.#commands.values()].filter((cmd) =>
      cmd.name === name || cmd.aliases?.includes(name)
    );
    const priority = Math.max(...matches.map((cmd) => cmd.priority ?? 0));
    const preferred = matches.filter((cmd) => (cmd.priority ?? 0) === priority);
    if (preferred.length > 1) {
      throw new Error(
        `Ambiguous command: ${name}. Use ${
          preferred.map((cmd) => cmd.id).sort().join(", ")
        }`,
      );
    }
    return preferred[0]?.id;
  }
  /** The same resolution owns display spellings and text invocation. */
  spelling(id: string): string {
    const cmd = this.#commands.get(id);
    const name = cmd?.name ?? id;
    try {
      return this.resolveSlash(name) === id ? name : id;
    } catch {
      return id;
    }
  }
  parse(name: string, text: string): { id: string; args: unknown } | undefined {
    const id = this.resolveSlash(name);
    if (!id) return;
    return {
      id,
      args: parseCommandArguments(
        this.metadata(id)!.arguments ?? noCommandArguments,
        text,
      ),
    };
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

export interface ContextTarget<T = unknown> {
  kind: string;
  data: T;
  /** An enclosing application area, rather than a thing inside that area. */
  area?: boolean;
}
export interface ContextAction {
  id: string;
  key: string;
  title: string;
  args: unknown;
  destructive: boolean;
  confirm?: string;
}
/** Two innermost thing groups, then the nearest area; app only without a thing. */
export function contextGroups(
  commands: CommandHub,
  targets: readonly ContextTarget[],
): ContextAction[][] {
  const concrete = targets.filter((target) =>
    target.kind !== "app" && !target.area
  );
  const groups = concrete.map((target) => commands.contextActions(target))
    .filter((actions) => actions.length).slice(0, 2);
  const area = targets.find((target) => target.area);
  if (area) groups.push(commands.contextActions(area));
  if (!concrete.length) {
    groups.push(commands.contextActions({ kind: "app", data: undefined }));
  }
  // A shared action (e.g. New session in a panel and app) appears once, in its
  // most specific group. Preserve different choices of a multi-item command.
  const seen = new Set<string>();
  return groups.map((group) =>
    group.filter((action) => {
      if (seen.has(action.key)) return false;
      seen.add(action.key);
      return true;
    })
  ).filter((group) => group.length);
}
