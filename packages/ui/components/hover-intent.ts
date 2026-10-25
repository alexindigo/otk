// SPDX-License-Identifier: LGPL-3.0-only

/** One hover/focus lifetime, including optional portalled regions. Callers own
 * presentation; this owner alone reads policy, schedules and cancels deadlines. */
export function hoverIntent(element: HTMLElement, options: {
  open(reason: "pointer" | "keyboard"): void;
  close(): void;
}) {
  const style = getComputedStyle(element);
  const delay = (token: string) => {
    const value = style.getPropertyValue(token).trim();
    return parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
  };
  const openDelay = delay("--hover-open-delay");
  const closeDelay = delay("--hover-close-delay");
  let opening: ReturnType<typeof setTimeout> | undefined;
  let closing: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const regions = new Set([element]);
  const releases = new Set<() => void>();
  const cancelOpen = () => clearTimeout(opening);
  const cancelClose = () => clearTimeout(closing);
  const cancel = () => {
    cancelOpen();
    cancelClose();
  };
  const contains = (target: Node | null) =>
    [...regions].some((region) => region.contains(target));
  const hovered = () => [...regions].some((region) => region.matches(":hover"));
  const rest = () => {
    cancel();
    const deadline = performance.now() + openDelay;
    const tick = () => {
      if (disposed) return;
      const remaining = deadline - performance.now();
      if (remaining > 0) opening = setTimeout(tick, remaining);
      else if (element.isConnected && element.matches(":hover")) {
        options.open("pointer");
      }
    };
    opening = setTimeout(tick, openDelay);
  };
  const leave = () => {
    cancel();
    const deadline = performance.now() + closeDelay;
    const tick = () => {
      if (disposed) return;
      const remaining = deadline - performance.now();
      if (remaining > 0) closing = setTimeout(tick, remaining);
      else if (!hovered() && !contains(document.activeElement)) options.close();
    };
    closing = setTimeout(tick, closeDelay);
  };
  const blur = (event: FocusEvent) => {
    if (!contains(event.relatedTarget as Node | null) && !hovered()) {
      cancel();
      options.close();
    }
  };
  const focus = (event: FocusEvent) => {
    cancel();
    if (
      [...regions].some((region) =>
        region !== element && region.contains(event.target as Node)
      )
    ) return;
    options.open("keyboard");
  };
  const move = (event: MouseEvent) => {
    if (
      [...regions].some((region) =>
        region !== element && region.contains(event.target as Node)
      )
    ) return;
    rest();
  };
  const bind = (region: HTMLElement, trigger: boolean) => {
    regions.add(region);
    const enter = trigger ? rest : cancelClose;
    const focusIn = trigger ? focus : cancelClose;
    region.addEventListener("mouseenter", enter);
    if (trigger) region.addEventListener("mousemove", move);
    region.addEventListener("mouseleave", leave);
    region.addEventListener("focusin", focusIn);
    region.addEventListener("focusout", blur);
    const release = () => {
      region.removeEventListener("mouseenter", enter);
      region.removeEventListener("mousemove", move);
      region.removeEventListener("mouseleave", leave);
      region.removeEventListener("focusin", focusIn);
      region.removeEventListener("focusout", blur);
      regions.delete(region);
      releases.delete(release);
    };
    releases.add(release);
    return release;
  };
  bind(element, true);
  return {
    cancel,
    retain: (region: HTMLElement) => bind(region, false),
    dispose() {
      disposed = true;
      cancel();
      for (const release of releases) release();
    },
  };
}
