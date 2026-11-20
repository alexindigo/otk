// SPDX-License-Identifier: LGPL-3.0-only
import { deliveryContract } from "../../../tests/support/delivery-contract.ts";
import { deliveryReceipt, scanDeliveries } from "../delivery.ts";
import { opencodeV2DigestMigrations } from "../digest-migrations.ts";
deliveryContract(
  2,
  scanDeliveries,
  opencodeV2DigestMigrations,
  deliveryReceipt,
);
