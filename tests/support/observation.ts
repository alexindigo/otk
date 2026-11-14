// SPDX-License-Identifier: LGPL-3.0-only
/** Fields computed only when selected; a missing selection is the full export. */
export function observation(
  fields: Record<string, () => unknown>,
  select: { fields?: string[]; entry?: string } | undefined,
  entry: (id: string) => unknown,
  scalarOnly: readonly string[] = [],
): Record<string, unknown> {
  if (!select) {
    return Object.fromEntries(
      Object.entries(fields).filter(([key]) => !scalarOnly.includes(key))
        .map(([key, value]) => [key, value()]),
    );
  }
  const unknown = (select.fields ?? []).filter((key) =>
    !Object.hasOwn(fields, key)
  );
  if (unknown.length) throw new Error(`Unknown observation fields: ${unknown}`);
  return {
    ...Object.fromEntries(
      (select.fields ?? []).map((key) => [key, fields[key]()]),
    ),
    ...(select.entry === undefined
      ? {}
      : { entry: entry(select.entry) ?? null }),
  };
}
