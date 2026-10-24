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
export interface PreferencePresentation {
  readonly order: number;
  readonly control: PreferenceControl;
}
export type PreferenceDefinition<K extends PreferenceKey = PreferenceKey> = {
  [P in K]: {
    readonly key: P;
    readonly default: Preferences[P];
    readonly validate: (value: unknown) => value is Preferences[P];
    readonly label: string;
    readonly display?: PreferencePresentation;
    readonly settings?: PreferencePresentation & { readonly group: string };
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
    const presentation = <T extends PreferencePresentation>(
      value: T | undefined,
    ): Readonly<T> | undefined => {
      if (!value) return;
      const control = value.control;
      if (
        control.kind === "toggle"
          ? typeof definition.default !== "boolean"
          : !control.options.length || !control.options.every((option) =>
            definition.validate(option.value)
          ) || !control.options.some((option) =>
            option.value === definition.default
          )
      ) {
        throw new Error(`Invalid preference control: ${definition.key}`);
      }
      return Object.freeze({
        ...value,
        control: control.kind === "select"
          ? Object.freeze({
            ...control,
            options: Object.freeze(
              control.options.map((option) => Object.freeze({ ...option })),
            ),
          })
          : Object.freeze({ kind: "toggle" as const }),
      });
    };
    this.#definitions.set(
      definition.key,
      Object.freeze({
        ...definition,
        default: structuredClone(definition.default),
        display: presentation(definition.display),
        settings: presentation(definition.settings),
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
  settings(group: string): readonly PreferenceDefinition[] {
    return this.list().filter((definition) =>
      definition.settings?.group === group
    )
      .sort((a, b) => a.settings!.order - b.settings!.order);
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
