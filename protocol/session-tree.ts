// SPDX-License-Identifier: LGPL-3.0-only
export type SessionLookup = (id: string) => { parentID?: string } | undefined;
export function sessionAncestors(id: string, lookup: SessionLookup): string[] {
  const seen = new Set([id]), ancestors: string[] = [];
  let parent = lookup(id)?.parentID;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    ancestors.push(parent);
    parent = lookup(parent)?.parentID;
  }
  return ancestors;
}
export function belongsToSession(
  id: string,
  rootID: string,
  lookup: SessionLookup,
): boolean {
  return id === rootID || sessionAncestors(id, lookup).includes(rootID);
}
