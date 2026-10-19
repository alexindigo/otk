// SPDX-License-Identifier: LGPL-3.0-only
import { Show } from "solid-js";
import type { ToolProps } from "../registries/renderers.ts";
import { useUiRegistries } from "../registries/context.tsx";
import ToolFrame from "./tools/ToolFrame.tsx";

/** Render a registered tool or the consumer-selected generic fallback. */
export default function ToolLine(props: ToolProps): import("solid-js").Element {
  const { tools } = useUiRegistries();
  return (
    <ToolFrame
      call={props.call}
      waiting={props.waiting || props.call.awaitingPermission}
      presentation={tools.presentation(props.call, {
        directory: props.directory,
        prefs: props.prefs,
      })}
    >
      <Show when={tools.resolve(props.call)} keyed>
        {(renderer) => {
          const Component = renderer;
          return <Component {...props} />;
        }}
      </Show>
    </ToolFrame>
  );
}
