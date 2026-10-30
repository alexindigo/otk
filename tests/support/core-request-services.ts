// SPDX-License-Identifier: LGPL-3.0-only
import { type OtkDb, Requests } from "@otk/store";
import { RequestCoordinator } from "../../core/requests/coordinator.ts";
import type { RpcRegistry } from "../../core/ws/registry.ts";
import type { ConnectionRequests } from "../../core/ws/connections.ts";
import { clientRequestPolicy } from "../../core/config/schema.ts";
import { cfg } from "./config.ts";
export async function requestServices(
  registry: RpcRegistry,
  db: OtkDb,
): Promise<ConnectionRequests> {
  const policy = cfg();
  const coordinator = new RequestCoordinator({
    registry,
    receipts: new Requests(db),
    policy: policy.requests,
  });
  await coordinator.start();
  return {
    coordinator,
    identity: () => "fixture",
    policy: clientRequestPolicy(policy),
    helloms: policy.connection.helloms,
  };
}
