// SPDX-License-Identifier: LGPL-3.0-only
import { apiBase } from "@otk/client";
import { Shell, type ThemeEngine } from "@otk/ui";
import { clientRequestPolicyFrom } from "@otk/protocol";
export default function App(props: { theme: ThemeEngine }) {
  const bootstrap = document.getElementById("otk-bootstrap")?.textContent;
  const boot = bootstrap ? JSON.parse(bootstrap) : {};
  const policy = boot.policy ? clientRequestPolicyFrom(boot.policy) : undefined;
  return (
    <Shell
      theme={props.theme}
      api={apiBase("", import.meta.url)}
      policy={policy}
      build={typeof boot.build === "string" ? boot.build : undefined}
    />
  );
}
