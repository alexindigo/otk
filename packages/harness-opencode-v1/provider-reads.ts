// SPDX-License-Identifier: LGPL-3.0-only
import {
  arrayReadCodec,
  catalogFileCodec,
  catalogModelCodec,
  clockReadCodec,
  historyAttachmentCodec,
  identityReadCodec,
  type ProviderReadCodecs,
  sessionListReadCodec,
} from "@otk/harness";
import { messagePrefetchCodec } from "./message-prefetch.ts";
/** Codecs matching this native sink's selected transient readers. */
export const opencodeV1ReadCodecs: ProviderReadCodecs = {
  "supervision.terminals": arrayReadCodec(),
  "opcv1.message.prefetch": messagePrefetchCodec,
  "identity.batch": identityReadCodec,
  "sessions.list": sessionListReadCodec,
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
