// SPDX-License-Identifier: LGPL-3.0-only
/** The provider machine's lexical path flavor, never the browser's platform. */
export interface PathSemantics {
  style: "posix" | "win32";
  separator: "/" | "\\";
}
