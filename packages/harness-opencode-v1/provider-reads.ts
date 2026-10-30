// SPDX-License-Identifier: LGPL-3.0-only
import { identityReadCodec, type ProviderReadCodecs } from "@otk/harness";
/** Codecs matching this native sink's selected transient readers. */
export const opencodeV1ReadCodecs: ProviderReadCodecs = {
  "identity.batch": identityReadCodec,
};
