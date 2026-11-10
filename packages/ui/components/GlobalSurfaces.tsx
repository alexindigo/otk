// SPDX-License-Identifier: LGPL-3.0-only
import { For } from "solid-js";
import { useUiRegistries } from "../registries/context.tsx";
import { useShellPorts } from "../shell/context.tsx";
/** The shell mounts registered location-level surfaces without owning their logic. */
export default function GlobalSurfaces() {
  const { global } = useUiRegistries(), shell = useShellPorts();
  return (
    <For
      each={global.available((capability) =>
        shell.servers().some((server) =>
          server.capabilities.includes(capability)
        )
      )}
      keyed={(definition) => definition.id}
    >
      {(definition) => {
        const Component = definition().component;
        return <Component />;
      }}
    </For>
  );
}
