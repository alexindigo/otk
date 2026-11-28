// SPDX-License-Identifier: MIT
/** T3 platform predicate, independent of its application utilities. */
export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function observeResize(
  elements: readonly Element[],
  resize: () => void,
): () => void {
  const observer = new ResizeObserver(resize);
  for (const element of elements) observer.observe(element);
  return () => observer.disconnect();
}
