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
  constructor(
    readonly context: () => CommandContext = () => ({}),
    readonly keys: (id: string) => string[] = () => [],
  ) {}
  register<A, R>(command: Command<A, R>): () => void {
    if (!command.id || this.#commands.has(command.id)) {
      throw new Error(`Duplicate or empty command: ${command.id}`);
    }
    const copy = Object.freeze({ ...command, slash: command.slash?.slice() });
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
