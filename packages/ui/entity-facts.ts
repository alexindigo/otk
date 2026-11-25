// SPDX-License-Identifier: LGPL-3.0-only
import { entityFacts, type EntityIdentity } from "@otk/client";
import type { SessionPorts } from "./registries/session.tsx";

/** Bind the common facts owner once; standalone components retain explicit facts. */
export const scopedEntityFacts = (
  ports: SessionPorts | undefined,
  identity: EntityIdentity,
) =>
  ports?.entityFacts?.(identity) ?? entityFacts(identity, {
    entities: ports?.entities?.(),
    session: (id) => ({
      title: ports?.entry(id)?.title,
    }),
  });
