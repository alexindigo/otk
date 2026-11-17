// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "contract-messages-pending-inventory" });
for (const kind of ["form", "permission"] as const) {
  test(
    `attention.failed-${kind}-inventory-is-visible-and-only-fresh-recovery-restores-needs-you`,
    {
      tag: ["@attention", "@contracts"],
    },
    async ({ isolatedState: state, page }) => {
      const values = await state.observe<
        { directory: string; form: string; permission: string }
      >();
      await openSession(state, page, values[kind]);
      const row = page.locator(
        `[data-project=${JSON.stringify(values.directory)}]`,
      );
      const lamp = row.getByRole("img", { name: "Needs you", exact: true });
      await expect(lamp).toBeVisible();
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: kind === "form" ? "hold" : "freeze",
      });
      await expect(
        page.getByText(
          kind === "form"
            ? "Could not refresh pending forms."
            : "Could not refresh pending permissions.",
          { exact: false },
        ).first(),
      ).toBeVisible();
      const retained = kind === "form"
        ? await state.product("form.list", {
          sessionID: values.form,
        })
        : await state.product("permission.list", {
          sessionID: values.permission,
        });
      expect(retained.map((item) => item.id)).toEqual([
        kind === "form" ? "frm_main" : "per_main",
      ]);
      await expect(lamp).toHaveCount(0);
      await expect(
        row.getByRole("img", { name: "No known activity", exact: true }),
      ).toBeVisible();
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "succeed",
      });
      await expect(lamp).toBeVisible();
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "release",
      });
      await expect(lamp).toHaveCount(0);
      await expect(
        row.getByRole("img", { name: "No known activity", exact: true }),
      ).toBeVisible();
    },
  );
}

test(
  "attention.dropped-native-location-retires-and-can-reacquire-the-same-pending-identity",
  {
    tag: ["@attention", "@contracts"],
  },
  async ({ isolatedState: state, page }) => {
    const values = await state.observe<
      { directory: string; dropped: string; drop: string }
    >();
    await openSession(state, page, values.drop);
    const row = page.locator(
      `[data-project=${JSON.stringify(values.dropped)}]`,
    );
    await expect(row.getByRole("img", { name: "Needs you", exact: true }))
      .toBeVisible();
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "disconnect",
    });
    expect(await state.product("permission.list", { sessionID: values.drop }))
      .toEqual([]);
    expect(await state.product("form.list", {})).toEqual([]);
    await expect(row.getByRole("img", { name: "Needs you", exact: true }))
      .toHaveCount(0);
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "thaw",
    });
    await expect(row.getByRole("img", { name: "Needs you", exact: true }))
      .toBeVisible();
    expect(
      (await state.product("permission.list", {
        sessionID: values.drop,
      })).map((item) => item.id),
    ).toEqual(["per_drop"]);
  },
);
