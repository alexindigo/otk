// SPDX-License-Identifier: LGPL-3.0-only
import type { ModelCatalog, ModelRef } from "@otk/protocol";

export interface ModelPickerEntry {
  key: string;
  ref: ModelRef;
  name: string;
  providerName: string;
  free: boolean;
  favourite: boolean;
  subtitle?: string;
}
export interface ModelPickerGroup {
  key: string;
  label: string;
  items: ModelPickerEntry[];
}
export const modelKey = (ref: ModelRef): string =>
  JSON.stringify([ref.provider, ref.model]);

/** Catalog retrieval policy is independent of rendering and preference storage. */
export function modelGroups(
  catalog: ModelCatalog | undefined,
  favourites: readonly ModelRef[],
  recent: readonly ModelRef[],
  current?: ModelRef,
): ModelPickerGroup[] {
  if (!catalog) return [];
  const entries = new Map<string, ModelPickerEntry>();
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      const ref = { provider: provider.id, model: model.id };
      entries.set(modelKey(ref), {
        key: modelKey(ref),
        ref,
        name: model.name || model.id,
        providerName: provider.name,
        free: model.free,
        favourite: favourites.some((item) => modelKey(item) === modelKey(ref)),
      });
    }
  }
  const included = new Set<string>();
  const section = (refs: readonly ModelRef[]) =>
    refs.flatMap((ref) => {
      const key = modelKey(ref), entry = entries.get(key);
      if (!entry || included.has(key)) return [];
      included.add(key);
      return [{ ...entry, subtitle: entry.providerName }];
    });
  const groups: ModelPickerGroup[] = [
    { key: "favourites", label: "Favourites", items: section(favourites) },
    { key: "recent", label: "Recent", items: section(recent) },
  ];
  for (const provider of catalog.providers) {
    const models = provider.models.filter((model) => {
      const key = modelKey({ provider: provider.id, model: model.id });
      return !included.has(key) &&
        (model.status !== "deprecated" ||
          (current !== undefined && key === modelKey(current)));
    }).toSorted((a, b) =>
      (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") ||
      a.name.localeCompare(b.name)
    );
    groups.push({
      key: `provider:${provider.id}`,
      label: provider.name,
      items: models.map((model) =>
        entries.get(modelKey({ provider: provider.id, model: model.id }))!
      ),
    });
  }
  return groups.filter((group) => group.items.length);
}
