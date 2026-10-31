// SPDX-License-Identifier: LGPL-3.0-only
import { remainingTabs } from "../../reuse/remaining-consumer.ts";
import { mountSourceProbe } from "./source.tsx";
if (location.search === "?source") mountSourceProbe();
else {
  const owner = remainingTabs();
  Object.assign(globalThis, { remainingOwner: owner });
  document.querySelector("#result")!.textContent = JSON.stringify(owner.facts);
}
