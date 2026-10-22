// SPDX-License-Identifier: LGPL-3.0-only
import { AsyncLocalStorage } from "node:async_hooks";
import { basename, fromFileUrl, isAbsolute, join, resolve } from "@std/path";

type Cleanup = () => void | Promise<void>;
const active = new AsyncLocalStorage<ResourceScope>();

function failureDetails(value: unknown, seen = new Set<unknown>()): unknown {
  if (!(value instanceof Error)) {
    return value === undefined ? undefined : String(value);
  }
  if (seen.has(value)) return "Repeated error reference";
  seen.add(value);
  return {
    name: value.name,
    message: value.message,
    stack: value.stack,
    cause: failureDetails(value.cause, seen),
    errors: value instanceof AggregateError
      ? value.errors.map((error) => failureDetails(error, seen))
      : undefined,
  };
}

/** A deadline is a failure bound, not permission to abandon the other owners. */
export async function bounded<T>(
  label: string,
  work: Promise<T>,
  ms = 5000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Cleanup timed out: ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ResourceScope {
  #disposers: { label: string; release: () => Promise<void> }[] = [];
  #directories: string[] = [];
  #evidence: (() => Promise<void>)[] = [];
  #errors: unknown[] = [];
  #closing?: Promise<void>;
  constructor(readonly name: string) {}

  /** Idempotence lives at registration, including explicitly stopped fixtures. */
  defer(
    label: string,
    dispose: Cleanup,
    budget: number | null = 5000,
  ): () => Promise<void> {
    if (this.#closing) {
      throw new Error("Cannot acquire resources during disposal");
    }
    let pending: Promise<void> | undefined;
    const release = () => pending ??= this.observe(label, dispose, budget);
    this.#disposers.push({ label, release });
    return release;
  }

  evidence(label: string, capture: Cleanup): void {
    let pending: Promise<void> | undefined;
    this.#evidence.push(() => pending ??= this.observe(label, capture));
  }

  async capture(): Promise<void> {
    for (const capture of this.#evidence) await capture();
  }

  /** Explicit finally cleanup records its error without masking a body error. */
  async observe(
    label: string,
    action: Cleanup,
    budget: number | null = 5000,
  ): Promise<void> {
    try {
      const work = Promise.resolve().then(action);
      if (budget === null) await work;
      else await bounded(label, work, budget);
    } catch (cause) {
      this.#errors.push(new Error(label, { cause }));
    }
  }

  async tempDir(prefix = "otk-"): Promise<string> {
    const directory = Deno.env.get("TMPDIR");
    if (!directory || !isAbsolute(directory)) {
      throw new Error(
        "Tests require an absolute disk-backed TMPDIR inside the project workspace",
      );
    }
    const parent = await Deno.realPath(directory);
    if (
      ["/tmp", "/run", "/dev/shm"].some((path) =>
        parent === path || parent.startsWith(path + "/")
      )
    ) {
      throw new Error("Test TMPDIR must be on the project workspace disk");
    }
    const path = await Deno.makeTempDir({ dir: parent, prefix });
    this.#directories.push(path);
    return path;
  }

  /** Export only evidence, never browser profiles, XDG databases or dependencies. */
  async #export(failure: unknown): Promise<void> {
    const files: { source: string; relative: string }[] = [];
    for (const directory of this.#directories) {
      try {
        for await (const entry of Deno.readDir(directory)) {
          if (
            entry.isFile &&
            /\.(?:json|html|png|log|heapsnapshot)$/.test(entry.name)
          ) {
            files.push({
              source: join(directory, entry.name),
              relative: join(basename(directory), entry.name),
            });
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    if (!failure && !files.length) return;
    const base = resolve(
      Deno.env.get("OTK_TEST_ARTIFACTS") ??
        fromFileUrl(new URL("../../.test-state/artifacts", import.meta.url)),
    );
    const target = join(
      base,
      `${Date.now()}-${Deno.pid}-${crypto.randomUUID()}`,
    );
    await Deno.mkdir(target, { recursive: true });
    await Deno.writeTextFile(
      join(target, "test.json"),
      JSON.stringify(
        {
          name: this.name,
          failure: failureDetails(failure),
          directories: this.#directories,
        },
        null,
        2,
      ),
    );
    for (const file of files) {
      const destination = join(target, file.relative);
      await Deno.mkdir(join(destination, ".."), { recursive: true });
      await Deno.copyFile(file.source, destination);
    }
    console.info("Test evidence:", target);
  }

  close(failure?: { error: unknown }): Promise<void> {
    return this.#closing ??= this.#close(failure);
  }

  async #close(failure: { error: unknown } | undefined): Promise<void> {
    const errors: unknown[] = failure === undefined ? [] : [failure.error];
    const attempt = async (label: string, action: Cleanup) => {
      try {
        await bounded(label, Promise.resolve().then(action));
      } catch (error) {
        errors.push(new Error(label, { cause: error }));
      }
    };
    await this.capture();
    for (const { release } of this.#disposers.toReversed()) await release();
    errors.push(...this.#errors);
    await attempt(
      "export test evidence",
      () =>
        this.#export(errors.length ? new AggregateError(errors) : undefined),
    );
    for (const directory of this.#directories.toReversed()) {
      await attempt(`remove ${directory}`, async () => {
        try {
          await Deno.remove(directory, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      });
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) {
      throw new AggregateError(errors, `Test and cleanup failed: ${this.name}`);
    }
  }
}

export function resources(): ResourceScope {
  const scope = active.getStore();
  if (!scope) {
    throw new Error(
      "Resource acquisition requires a scoped test or withResources()",
    );
  }
  return scope;
}

export async function withResources<T>(
  name: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const scope = new ResourceScope(name);
  return await active.run(scope, async () => {
    let value!: T, failure: { error: unknown } | undefined;
    try {
      value = await run();
    } catch (error) {
      failure = { error };
    }
    await scope.close(failure);
    return value;
  });
}

/** Keep Deno's normal resource/op sanitizers; cleanup precedes their observation. */
export function test(
  name: string,
  run: (context: Deno.TestContext) => void | Promise<void>,
): void {
  Deno.test(name, (context) => withResources(name, () => run(context)));
}

export function tempDir(prefix?: string): Promise<string> {
  return resources().tempDir(prefix);
}

/** Transfer a fully acquired child lifetime, or unwind it before rejecting. */
export async function acquire<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const child = new ResourceScope(name);
  let transferred = false;
  resources().defer(name, () => transferred ? child.close() : undefined, null);
  return await active.run(child, async () => {
    try {
      const result = await run();
      transferred = true;
      return result;
    } catch (error) {
      await child.close({ error });
      throw error;
    }
  });
}
