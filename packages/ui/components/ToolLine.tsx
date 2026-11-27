// SPDX-License-Identifier: LGPL-3.0-only
import { For, Show } from "solid-js";
import type { ToolProps } from "../registries/renderers.ts";
import { useUiRegistries } from "../registries/context.tsx";
import ToolFrame from "./tools/ToolFrame.tsx";
import { usePathSemantics } from "./PathProvider.tsx";
import { TreeItem } from "./Tree.tsx";

/** Render a registered tool or the consumer-selected generic fallback. */
export default function ToolLine(props: ToolProps): import("solid-js").Element {
  const { tools } = useUiRegistries();
  const paths = usePathSemantics();
  const renderer = () => tools.resolve(props.call);
  return (
    <ToolFrame
      call={props.call}
      row={props.row}
      waiting={props.waiting}
      prefs={props.prefs}
      onOpenChild={props.onOpenChild}
      hasContent={() => !!(renderer() || props.call.children?.length)}
      presentation={tools.presentation(props.call, {
        directory: props.directory,
        paths: paths(),
        prefs: props.prefs,
      })}
      body={() => (
        <>
          <Show when={renderer()} keyed>
            {(renderer) => {
              const Component = renderer;
              return <Component {...props} />;
            }}
          </Show>
        </>
      )}
      nested={props.call.children?.length
        ? (after) => (
          <For
            each={props.call.children}
            keyed={(call) => call.callID}
          >
            {(call) => (
              <TreeItem
                last={!after &&
                  call().callID === props.call.children?.at(-1)?.callID}
              >
                <ToolLine
                  {...props}
                  call={call()}
                  row={undefined}
                  waiting={false}
                />
              </TreeItem>
            )}
          </For>
        )
        : undefined}
    />
  );
}
