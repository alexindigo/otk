// SPDX-License-Identifier: LGPL-3.0-only
import {
  arrayReadCodec,
  catalogFileCodec,
  catalogModelCodec,
  identityReadCodec,
  type ProviderReadCodecs,
} from "@otk/harness";
/** Codecs matching this native sink's selected transient readers. */
export const opencodeV1ReadCodecs: ProviderReadCodecs = {
  "identity.batch": identityReadCodec,
  "catalog.agents": arrayReadCodec(),
  "catalog.commands": arrayReadCodec(),
  "catalog.skills": arrayReadCodec(),
  "catalog.models": catalogModelCodec,
  "catalog.resources": arrayReadCodec(),
  "catalog.questions": arrayReadCodec(),
  "catalog.files": catalogFileCodec,
};
