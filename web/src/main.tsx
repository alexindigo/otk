// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import { render } from "@solidjs/web";

function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <main>
      <h1>OTK / Open Terminal Kit</h1>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        {count()}
      </button>
    </main>
  );
}

render(() => <Counter />, document.getElementById("app")!);
