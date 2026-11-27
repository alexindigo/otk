// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import {
  liveFailedHelper,
  liveResumedHelper,
} from "../../pages/failed-helper.ts";

test.use({ profile: "attention-failed-helper" });

test("attention.stock-native-failed-helper-fixture", {
  tag: ["@attention", "@isolated"],
}, async ({ isolatedState: state }, info) => {
  const witness = await liveFailedHelper(state);
  expect(witness.terminal.id).toBeTruthy();
  expect(witness.result).toBeTruthy();
  await info.attach("failed-helper-native-facts", {
    body: JSON.stringify(witness),
    contentType: "application/json",
  });
});

test("attention.stock-native-resumed-helper-fixture", {
  tag: ["@attention", "@isolated"],
}, async ({ isolatedState: state }, info) => {
  const witness = await liveResumedHelper(state);
  expect(witness.runs).toHaveLength(2);
  await info.attach("resumed-helper-native-facts", {
    body: JSON.stringify(witness),
    contentType: "application/json",
  });
});
