// SPDX-License-Identifier: LGPL-3.0-only
/** Serializable runtime schema shared by structured and text command callers. */
export interface CommandArguments {
  type:
    | "none"
    | "string"
    | "number"
    | "boolean"
    | "object"
    | "array"
    | "unknown"
    | "local";
  optional?: boolean;
  properties?: Readonly<Record<string, CommandArguments>>;
  items?: CommandArguments;
  enum?: readonly (string | number | boolean)[];
  /** An object's named string field receives the remaining text verbatim. */
  rest?: string;
}
export const noCommandArguments: CommandArguments = Object.freeze({
  type: "none",
});
export function freezeCommandArguments(
  schema: CommandArguments,
): CommandArguments {
  return Object.freeze({
    ...schema,
    ...(schema.enum ? { enum: Object.freeze([...schema.enum]) } : {}),
    ...(schema.items ? { items: freezeCommandArguments(schema.items) } : {}),
    ...(schema.properties
      ? {
        properties: Object.freeze(
          Object.fromEntries(
            Object.entries(schema.properties).map((
              [name, field],
            ) => [name, freezeCommandArguments(field)]),
          ),
        ),
      }
      : {}),
  });
}

export function validateCommandArguments(
  schema: CommandArguments,
  value: unknown,
  path = "arguments",
): void {
  if (value === undefined && (schema.optional || schema.type === "none")) {
    return;
  }
  if (schema.type === "unknown") return;
  if (schema.type === "local") {
    if (
      !value || typeof value !== "object" ||
      Object.getPrototypeOf(value) === Object.prototype
    ) throw new Error(`Invalid ${path}: requires local input`);
    return;
  }
  if (schema.type === "none") {
    throw new Error("This command takes no arguments");
  }
  if (schema.enum && !schema.enum.some((option) => option === value)) {
    throw new Error(`Invalid ${path}: expected ${schema.enum.join(" | ")}`);
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`Invalid ${path}: expected array`);
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index++) {
        validateCommandArguments(
          schema.items,
          value[index],
          `${path}[${index}]`,
        );
      }
    }
    return;
  }
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Invalid ${path}: expected object`);
    }
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      validateCommandArguments(
        field,
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
    }
    return;
  }
  if (
    typeof value !== schema.type ||
    (schema.type === "number" && !Number.isFinite(value))
  ) {
    throw new Error(`Invalid ${path}: expected ${schema.type}`);
  }
}

/** JSON covers structured targets; strings and rest fields preserve free text. */
export function parseCommandArguments(
  schema: CommandArguments,
  text: string,
): unknown {
  if (!text.trim()) return undefined;
  if (schema.type === "local") {
    throw new Error("This command requires local input");
  }
  let value: unknown;
  if (schema.rest) value = { [schema.rest]: text };
  else if (schema.type === "string") {
    value = text.startsWith('"') ? JSON.parse(text) : text;
  } else value = JSON.parse(text);
  validateCommandArguments(schema, value);
  return value;
}
