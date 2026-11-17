// SPDX-License-Identifier: LGPL-3.0-only
import { expect, type Locator, type Page } from "@playwright/test";

/** The one marker the shared PrimaryAction control declares (triage decision 5). */
export const PRIMARY_ACTION = "[data-primary-action]";
/** Composer and takeover hosts that may each contain one primary action. */
export const PRIMARY_HOSTS = ".otk-prompt,.otk-takeover";
/** UI rule 3: unavailable secondary controls hide; only the primary may be disabled. */
export const DISABLED_SECONDARY =
  `:is(:disabled,[aria-disabled=true]):not(${PRIMARY_ACTION})`;

export interface PrimaryFact {
  visible: boolean;
  disabled: boolean;
  reason: string;
  siblings: number;
}
/** In-page probe (self-contained, so Playwright can serialize it). */
export function primaryFacts(
  root: ParentNode,
  [marker, hosts]: readonly [string, string],
): PrimaryFact[] {
  const rendered = (el: Element) =>
    el.getClientRects().length > 0 && !el.closest("[hidden],[inert]");
  const presented = [
    ...(root instanceof Element && root.matches(hosts) ? [root] : []),
    ...Array.from(root.querySelectorAll(hosts)),
  ].filter(rendered);
  const owner = (el: Element) => el.closest(hosts) ?? el.parentElement!;
  const markers = [
    ...(root instanceof HTMLElement && root.matches(marker) ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>(marker)),
  ];
  // A host the shell is not presenting (the composer under a takeover) offers
  // no primary; an unrendered primary inside a presented host still fails.
  const facts = markers.filter((el) => rendered(owner(el))).map((el) => {
    const r = el.getBoundingClientRect(), c = getComputedStyle(el);
    const host = owner(el);
    return {
      visible: r.width > 0 && r.height > 0 && c.visibility !== "hidden" &&
        !el.closest("[hidden],[inert]"),
      disabled: el.matches(":disabled,[aria-disabled=true]"),
      reason: (el.getAttribute("aria-description") ?? "").trim(),
      siblings: Array.from(host.querySelectorAll(marker)).filter((candidate) =>
        owner(candidate) === host
      ).length,
    };
  });
  for (const host of presented) {
    if (
      !Array.from(host.querySelectorAll(marker)).some((candidate) =>
        owner(candidate) === host
      )
    ) {
      facts.push({ visible: false, disabled: false, reason: "", siblings: 0 });
    }
  }
  return facts;
}
/** Violations of the primary-action exception itself, never exempted. */
export function primaryViolations(
  facts: readonly PrimaryFact[],
): { primary: string }[] {
  return facts.flatMap((fact) => [
    ...(fact.siblings !== 1
      ? [{ primary: `${fact.siblings} in one host` }]
      : []),
    ...(fact.siblings > 0 && !fact.visible
      ? [{ primary: fact.disabled ? "disabled and hidden" : "hidden" }]
      : []),
    ...(fact.disabled && !fact.reason
      ? [{ primary: "disabled without reason" }]
      : []),
  ]);
}

/** The persistent primary stays visible and states why it cannot run. */
export async function expectPrimaryBlocked(
  control: Locator,
  reason: string,
): Promise<void> {
  await expect(control).toBeVisible();
  await expect(control).toBeDisabled();
  await expect(control).toHaveAttribute("aria-description", reason);
}
/** The ordinary composer Send, located by its declared marker. */
export const send = (page: Page): Locator =>
  page.locator(`.otk-prompt ${PRIMARY_ACTION}`);

/** Locator form of rule 3 for scenes outside the rendered region audit. */
export async function expectRuleThree(scope: Page | Locator): Promise<void> {
  await expect(scope.locator(DISABLED_SECONDARY)).toHaveCount(0);
  expect(primaryViolations(await readPrimary(scope))).toEqual([]);
}
export function readPrimary(scope: Page | Locator): Promise<PrimaryFact[]> {
  const root = "mainFrame" in scope ? scope.locator(":root") : scope;
  return root.evaluate(primaryFacts, [PRIMARY_ACTION, PRIMARY_HOSTS] as const);
}
