// SPDX-License-Identifier: LGPL-3.0-only
import { metaList } from "./format.ts";
import type { Note, NotificationLocation } from "./notifications.ts";

export function notificationSessionLabel(
  location: NotificationLocation,
): string | undefined {
  return location.task === location.session ? undefined : location.session;
}

export function notificationBody(note: Note): string | undefined {
  const location = note.location;
  if (!location) return note.body;
  return metaList([
    location.project.name,
    location.task,
    notificationSessionLabel(location),
  ]);
}
