// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type { ToolProps } from "../registries/renderers.ts";
import { useUiRegistries } from "../registries/context.tsx";
import ToolFrame from "./tools/ToolFrame.tsx";
import { usePathSemantics } from "./PathProvider.tsx";

/** Render a registered tool or the consumer-selected generic fallback. */
export default function ToolLine(props: ToolProps): import("solid-js").Element {
  const { tools } = useUiRegistries();
  const paths = usePathSemantics();
  return (
    <ToolFrame
      call={props.call}
      waiting={props.waiting}
      prefs={props.prefs}
      presentation={tools.presentation(props.call, {
        directory: props.directory,
        paths: paths(),
        prefs: props.prefs,
      })}
      body={() => (
        <>
          <Show when={tools.resolve(props.call)} keyed>
            {(renderer) => {
              const Component = renderer;
              return <Component {...props} />;
            }}
          </Show>
          <For each={props.call.children} keyed={(call) => call.callID}>
            {(call) => <ToolLine {...props} call={call()} waiting={false} />}
          </For>
        </>
      )}
    />
  );
}
