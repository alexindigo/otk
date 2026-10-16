// SPDX-License-Identifier: LGPL-3.0-only
import { apiBase } from "@otk/client";
import { Shell, type ThemeEngine } from "@otk/ui";
export default function App(props: { theme: ThemeEngine }) {
  return <Shell theme={props.theme} api={apiBase("", import.meta.url)} />;
}
