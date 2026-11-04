// SPDX-License-Identifier: LGPL-3.0-only
import { ThemeRegistry } from "../theme/registry.ts";
import { registerOtkThemes } from "../features/theme/otk.ts";
/** Public test-process JSON boundary; only this package resolves its theme data. */
const registry = new ThemeRegistry();
registerOtkThemes(registry);
console.log(JSON.stringify({
  schema: 1,
  themes: registry.list().map(({ id, label }) => ({
    label,
    ...registry.resolve(id, "dark"),
  })),
}));
