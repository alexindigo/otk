// SPDX-License-Identifier: LGPL-3.0-only
import map from "../../tests/browser/areas.json" with { type: "json" };

export const areas = map.areas;
export type Fallback = "all" | "contracts" | null;
export interface Selection {
  schema: number;
  base: string;
  paths: string[];
  areas: string[];
  smoke: boolean;
  integration: string[];
  broad: boolean;
  fallback: Fallback;
  themes: boolean;
  scale: boolean;
  milestone: boolean;
  reasons: string[];
}
export function pathsFromNul(bytes: Uint8Array): string[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text && !text.endsWith("\0")) {
    throw new Error("Changed paths must be NUL-delimited");
  }
  const paths = text ? text.slice(0, -1).split("\0") : [];
  if (
    paths.some((p) => !p || p.startsWith("/") || p.split("/").includes(".."))
  ) {
    throw new Error("Changed paths must be repository-relative");
  }
  return [...new Set(paths)];
}
export function select(
  paths: string[],
  explicit: string[] = [],
  base = "missing",
): Selection {
  if (explicit.some((a) => !areas.includes(a))) {
    throw new Error("Unknown explicit area");
  }
  const chosen = new Set(explicit);
  const integration = new Set<string>();
  const reasons: string[] = [];
  let broad = base === "missing",
    fallback: Fallback = base === "missing" ? "all" : null,
    themes = false,
    scale = false,
    milestone = false;
  for (const path of paths) {
    const rules = map.rules.filter((rule) => {
      const pattern = rule.pattern.replace(/^\(\?i\)/, "");
      return new RegExp(pattern, rule.pattern.startsWith("(?i)") ? "i" : "")
        .test(path);
    });
    // Browser cases select their semantic area, not a guessed import graph.
    const testArea = path.match(
      /^tests\/browser\/(?:behavior|contracts)\/([^/]+)\//,
    )?.[1];
    const integrationFile = /^tests\/integration\/[^/]+_test\.ts$/.test(path);
    if (integrationFile) {
      integration.add(path);
      for (const [area, files] of Object.entries(map.integration)) {
        if (files.includes(path.slice("tests/integration/".length))) {
          chosen.add(area);
        }
      }
      reasons.push(`${path}: changed integration file`);
    }
    if (!rules.length && testArea && areas.includes(testArea)) {
      chosen.add(testArea);
      reasons.push(`${path}: test area ${testArea}`);
    } else if (!rules.length && !integrationFile) {
      broad = true;
      fallback ??= "contracts";
      reasons.push(`${path}: unclassified/deleted/renamed -> contracts`);
    }
    for (const rule of rules) {
      reasons.push(`${path}: map row ${rule.id}`);
      for (const a of rule.areas ?? []) chosen.add(a);
      broad ||= !!rule.broad;
      if (rule.broad) fallback ??= "contracts";
      themes ||= !!rule.themes &&
        /\.css$|token|(^|\/)themes?([/.]|$)|(^|\/)fonts?\//i.test(path);
      scale ||= !!rule.scale;
      milestone ||= !!rule.milestone;
    }
  }
  if (fallback === "all") {
    areas.forEach((a) => chosen.add(a));
    themes = true;
    reasons.push(
      "missing base -> all areas and themes",
    );
  }
  for (const area of chosen) {
    for (const file of map.integration[area as keyof typeof map.integration]) {
      integration.add(`tests/integration/${file}`);
    }
  }
  return {
    schema: 1,
    base,
    paths,
    areas: [...chosen].sort(),
    smoke: true,
    integration: broad ? ["*"] : [...integration].sort(),
    broad,
    fallback,
    themes,
    scale,
    milestone,
    reasons,
  };
}

export function browserGrep(selection: Pick<Selection, "areas" | "fallback">) {
  const tags = [
    ...selection.areas,
    ...(selection.fallback === "contracts" ? ["contracts"] : []),
    "smoke",
  ];
  return `@(${tags.join("|")})(?:\\s|$)`;
}
export function validateCollection(
  tags: string[][],
  selected: string[] = areas,
) {
  if (!tags.length) throw new Error("Empty browser collection");
  for (const row of tags) {
    if (!row.some((t) => areas.includes(t.replace(/^@/, "")))) {
      throw new Error("Collected test has no area");
    }
  }
  for (const area of selected) {
    if (!tags.some((row) => row.includes(`@${area}`))) {
      throw new Error(`Empty selection for area ${area}`);
    }
  }
}
/** Required smoke contracts remain exact; additional smoke journeys also run. */
export function validateSmoke(tags: string[][], project: string) {
  const ids = tags.filter((row) => row.includes("@smoke")).flatMap((row) =>
    row.filter((tag) => tag.startsWith("@smoke."))
  );
  if (
    ids.length !== 4 ||
    ["native-prompt", "attention", "navigation", "preferences"].some((id) =>
      !ids.includes(`@smoke.${id}`)
    )
  ) throw new Error(`Incomplete smoke contract: ${project}`);
}
