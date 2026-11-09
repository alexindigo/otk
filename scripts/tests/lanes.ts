// SPDX-License-Identifier: LGPL-3.0-only
export const nativeLanes = { A: "2.2.6", B: "2.2.6", C: "1.19.3" } as const;
export type NativeLane = keyof typeof nativeLanes;
export function nativeLane(version: string, explicit?: string): NativeLane {
  if (explicit) {
    if (
      !(explicit in nativeLanes) ||
      nativeLanes[explicit as NativeLane] !== version
    ) throw new Error("Native version does not match lane A/B/C");
    return explicit as NativeLane;
  }
  // Historical runners remain selectable while their V1 coverage is retained.
  if (version === "1.18.34" || version === "2.2.6") return "A";
  if (version === "1.18.35") return "B";
  if (version === "1.19.3") return "C";
  throw new Error(`No qualified native lane for ${version}`);
}
