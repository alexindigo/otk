// SPDX-License-Identifier: LGPL-3.0-only
import type { Preferences } from "./preference-contract.ts";
export type { Preferences } from "./preference-contract.ts";
export type PreferenceKey = Extract<keyof Preferences, string>;

export type PreferenceControl =
  | { readonly kind: "toggle" }
  | {
    readonly kind: "select";
    readonly options: readonly {
      readonly value: string;
      readonly label: string;
    }[];
  };
export type PreferenceDefinition<K extends PreferenceKey = PreferenceKey> = {
  [P in K]: {
    readonly key: P;
    readonly default: Preferences[P];
    readonly validate: (value: unknown) => value is Preferences[P];
    readonly label: string;
    readonly display?: {
      readonly order: number;
      readonly control: PreferenceControl;
    };
  };
}[K];

/** Empty, consumer-owned policy registry; no concrete feature imports. */
export class PreferenceRegistry {
  #definitions = new Map<PreferenceKey, PreferenceDefinition>();
  register<K extends PreferenceKey>(definition: PreferenceDefinition<K>): void {
    if (this.#definitions.has(definition.key)) {
      throw new Error(`Duplicate preference: ${definition.key}`);
    }
    if (!definition.validate(definition.default)) {
      throw new Error(`Invalid preference default: ${definition.key}`);
    }
    const control = definition.display?.control;
    if (
      control &&
      (control.kind === "toggle"
        ? typeof definition.default !== "boolean"
        : !control.options.length ||
          !control.options.every((option) =>
            definition.validate(option.value)
          ) ||
          !control.options.some((option) =>
            option.value === definition.default
          ))
    ) {
      throw new Error(`Invalid preference control: ${definition.key}`);
    }
    const display = definition.display && Object.freeze({
      ...definition.display,
      control: control?.kind === "select"
        ? Object.freeze({
          ...control,
          options: Object.freeze(
            control.options.map((option) => Object.freeze({ ...option })),
          ),
        })
        : Object.freeze({ kind: "toggle" as const }),
    });
    this.#definitions.set(
      definition.key,
      Object.freeze({
        ...definition,
        default: structuredClone(definition.default),
        display,
      }) as PreferenceDefinition,
    );
  }
  list(): readonly PreferenceDefinition[] {
    return [...this.#definitions.values()];
  }
  display(): readonly PreferenceDefinition[] {
    return this.list().filter((definition) => definition.display)
      .sort((a, b) => a.display!.order - b.display!.order);
  }
  defaults(): Readonly<Preferences> {
    const defaults: Partial<Preferences> = {};
    for (const definition of this.list()) {
      Object.assign(defaults, {
        [definition.key]: structuredClone(definition.default),
      });
    }
    return defaults as Preferences;
  }
  validate(key: unknown, value: unknown): key is PreferenceKey {
    return typeof key === "string" &&
      (this.#definitions.get(key as PreferenceKey)?.validate(value) ?? false);
  }
}

export const booleanPreference = (value: unknown): value is boolean =>
  typeof value === "boolean";
