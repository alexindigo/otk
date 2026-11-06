// SPDX-License-Identifier: LGPL-3.0-only
import {
  arrayReadCodec,
  catalogFileCodec,
  catalogModelCodec,
  clockReadCodec,
  historyAttachmentCodec,
  identityReadCodec,
  type ProviderReadCodecs,
} from "@otk/harness";
/** Codecs matching this native sink's selected transient readers. */
export const opencodeV1ReadCodecs: ProviderReadCodecs = {
  "identity.batch": identityReadCodec,
  "message.clock": clockReadCodec,
  "history.list": arrayReadCodec(),
  "history.entries": arrayReadCodec(),
  "history.attachments": historyAttachmentCodec,
  "catalog.agents": arrayReadCodec(),
  "catalog.commands": arrayReadCodec(),
  "catalog.skills": arrayReadCodec(),
  "catalog.models": catalogModelCodec,
  "catalog.resources": arrayReadCodec(),
  "catalog.questions": arrayReadCodec(),
  "activity.status": arrayReadCodec(),
  "activity.permissions": arrayReadCodec(),
  "catalog.files": catalogFileCodec,
};
