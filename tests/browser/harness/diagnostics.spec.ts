// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../fixtures/isolated.ts";
import { expect } from "../fixtures/evidence.ts";
import { controllerResponse } from "../fixtures/protocol.ts";

test("harness.controller-diagnostic-channels", {
  tag: ["@harness", "@fixture-acceptance"],
}, async ({ isolatedState: state }) => {
  await state.controller.call("scenario", {
    lease: state.lease.lease,
    action: "succeed",
  });
  expect(await state.product("prefs.get", {})).toEqual(state.lease.baseline);
  await expect.poll(() =>
    ["debug", "log", "info"].every((method) =>
      state.controller.log.includes(`fixture diagnostic ${method}`)
    )
  ).toBe(true);
});

test("harness.controller-protocol-names-invalid-line", {
  tag: ["@harness", "@fixture-acceptance"],
}, () => {
  expect(() => controllerResponse("stray non-protocol diagnostic")).toThrow(
    'Controller protocol error on line "stray non-protocol diagnostic"',
  );
  expect(() => controllerResponse('{"not":"a response"}')).toThrow(
    'Controller protocol error on line "{\\"not\\":\\"a response\\"}"',
  );
});
