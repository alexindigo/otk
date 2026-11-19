// SPDX-License-Identifier: LGPL-3.0-only
/** One proportional coordinate system for painting, track clicks and dragging. */
export function scrollbarGeometry(
  viewport: number,
  content: number,
  position: number,
  track: number,
) {
  const maximum = Math.max(0, content - viewport);
  const size = content > 0
    ? Math.min(track, track * viewport / content)
    : track;
  const travel = Math.max(0, track - size);
  const offset = maximum
    ? travel * Math.max(0, Math.min(position, maximum)) / maximum
    : 0;
  return { size, offset, travel, maximum };
}
export function scrollbarPosition(
  offset: number,
  viewport: number,
  content: number,
  track: number,
) {
  const { travel, maximum } = scrollbarGeometry(viewport, content, 0, track);
  return travel ? Math.max(0, Math.min(offset, travel)) / travel * maximum : 0;
}
