// SPDX-License-Identifier: LGPL-3.0-only
import map from "../../tests/browser/areas.json" with { type: "json" };

export const areas = map.areas;
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
) {
  if (explicit.some((a) => !areas.includes(a))) {
    throw new Error("Unknown explicit area");
  }
  const chosen = new Set(explicit);
  const integration = new Set<string>();
  const reasons: string[] = [];
  let broad = base === "missing",
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
    if (!rules.length && testArea && areas.includes(testArea)) {
      chosen.add(testArea);
      reasons.push(`${path}: test area ${testArea}`);
    } else if (!rules.length) {
      broad = true;
      reasons.push(`${path}: unclassified/deleted/renamed -> broad`);
    }
    for (const rule of rules) {
      reasons.push(`${path}: map row ${rule.id}`);
      for (const a of rule.areas ?? []) chosen.add(a);
      broad ||= !!rule.broad;
      themes ||= rule.themes === "always" ||
        rule.themes === "style" && /\.css$|token/.test(path);
      scale ||= !!rule.scale;
      milestone ||= !!rule.milestone;
    }
  }
  if (broad) {
    areas.forEach((a) => chosen.add(a));
    themes = true;
    reasons.push(
      base === "missing"
        ? "missing base -> broad"
        : "shared/unclassified -> all versions",
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
    themes,
    scale,
    milestone,
    reasons,
  };
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
