// SPDX-License-Identifier: LGPL-3.0-only
/** Invocation-time context supplied by the consumer, never browser globals. */
export interface CommandContext {
  sidecar?: string;
  session?: string;
  focus?: string;
  dialog?: string;
}
/** Data-only owner metadata; discovery visibility does not hide key labels. */
export interface CommandMetadata {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly slash?: readonly string[];
  readonly hidden?: boolean;
}
export interface Command<A = unknown, R = unknown> extends CommandMetadata {
  /** Feature-owned context contribution; args are the target's captured data. */
  context?: {
    kind: string | readonly string[];
    title?(args: A): string;
    /** One feature registration may project several invocation-specific choices. */
    items?(args: A): { key?: string; title: string; args: A }[];
    destructive?: boolean;
    order?: number;
  };
  enabled?(context: CommandContext, args?: A): boolean;
  run(context: CommandContext, args: A): R | Promise<R>;
}
export interface ListedCommand {
  cmd: CommandMetadata;
  enabled: boolean;
  keys: string[];
}
function commandMetadata(command: CommandMetadata): CommandMetadata {
  return Object.freeze({
    id: command.id,
    title: command.title,
    category: command.category,
    hidden: command.hidden,
    slash: command.slash && Object.freeze(command.slash.slice()),
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
  ) {}
  register<A, R>(command: Command<A, R>): () => void {
    if (!command.id || this.#commands.has(command.id)) {
      throw new Error(`Duplicate or empty command: ${command.id}`);
    }
    const copy = Object.freeze({
      ...command,
      slash: command.slash?.slice(),
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
    return command && commandMetadata(command);
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
    return !!command && (command.enabled?.(context, args) ?? true);
  }
  async run<R = void>(id: string, args?: unknown): Promise<R> {
    const command = this.#commands.get(id), context = this.context();
    if (!command) throw new Error(`Unknown command: ${id}`);
    if (!this.enabled(id, context, args)) {
      throw new Error(`Command unavailable: ${id}`);
    }
    return await command.run(context, args) as R;
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
    return await this.run<R>(current.id, current.args);
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
          args: target.data,
        }]);
      return items.filter((item) =>
        this.enabled(command.id, context, item.args)
      ).map((item) => {
        const action = {
          id: command.id,
          key: JSON.stringify([command.id, item.key ?? item.title]),
          title: item.title,
          args: item.args,
          destructive: command.context?.destructive ?? false,
        };
        this.#actions.set(action, { command, target });
        return action;
      });
    });
  }
  list(context: CommandContext = this.context()): ListedCommand[] {
    return [...this.#commands.values()].filter((cmd) => !cmd.hidden).map((
      cmd,
    ) => ({
      cmd: commandMetadata(cmd),
      enabled: cmd.enabled?.(context) ?? true,
      keys: this.keys(cmd.id),
    }));
  }
  resolveSlash(name: string): string | undefined {
    return [...this.#commands.values()].find((cmd) => cmd.slash?.includes(name))
      ?.id;
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
