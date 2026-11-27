// SPDX-License-Identifier: LGPL-3.0-only
import { basename } from "node:path";
import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import type { TestState } from "../fixtures/test-state.ts";
import { openSession } from "../fixtures/wire.ts";
import { prompt, revealAcquired } from "./transcript.ts";

function checksum(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, payload: Buffer): Buffer {
  const bytes = Buffer.alloc(payload.length + 12);
  bytes.writeUInt32BE(payload.length);
  bytes.write(type, 4);
  payload.copy(bytes, 8);
  bytes.writeUInt32BE(checksum(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

export function samplePng(
  width: number,
  height: number,
  scene: number,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(height * stride);
  const colors = [[246, 242, 234], [216, 205, 185], [52, 46, 41], [
    216,
    98,
    40,
  ]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width, v = y / height;
      let ink = 0;
      if (u > 0.05 && u < 0.95 && v > 0.08 && v < 0.17) {
        ink = u < .31 ? 2 : u > .78 ? 3 : 1;
      }
      if (u > 0.08 && u < 0.92 && v > 0.24 && v < 0.90) {
        const col = Math.floor(u * (scene === 0 ? 4 : scene === 1 ? 1 : 6));
        const row = Math.floor((v - 0.24) * (scene === 1 ? 10 : 3));
        const edge = u * (scene === 0 ? 4 : scene === 1 ? 1 : 6) % 1 > .13;
        if (edge && (v - 0.24) * (scene === 1 ? 10 : 3) % 1 < .79) {
          ink = row === 0 && col === scene ? 3 : 1;
        }
      }
      pixels.set(colors[ink], y * stride + x * 3 + 1);
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const samples = [
  {
    label: "Cabinet",
    alt: "Cabinet mockup",
    name: "a.png",
    width: 320,
    height: 200,
  },
  { label: "Slab", alt: "Slab mockup", name: "b.png", width: 200, height: 320 },
  { label: "Beam", alt: "Beam mockup", name: "c.png", width: 400, height: 100 },
] as const;
export const ending = "These mockups use the same controls.";

export async function openImages(
  state: TestState,
  page: Page,
  compact = false,
) {
  const project = `TemporaryFiles/${basename(state.directory)}`;
  const images = samples.map(({ width, height }, i) =>
    samplePng(width, compact ? [145, 100, 75][i] : height, i).toString("base64")
  );
  const { home } = await state.controller.call<{ home: string }>(
    "writeHomeFiles",
    {
      lease: state.lease.lease,
      files: {
        ...Object.fromEntries(
          samples.map(({ name }, i) => [`${project}/${name}`, images[i]]),
        ),
        "Downloads/outside.png": images[0],
        [`${project}/notes.txt`]: Buffer.from("Review notes, not an image")
          .toString("base64"),
      },
    },
  );
  const { id } = await state.native<{ id: string }>("/session", "POST", {
    title: "Picker mockups",
  });
  await openSession(state, page, id);
  const reply = [
    "Three directions for the picker:",
    ...samples.map(({ name, alt, label }, i) =>
      `**${label}**  \n![${alt}](${i === 1 ? home : "~"}/${project}/${name})`
    ),
  ].join("  \n") + "\n\n" + ending;
  const reasons = [
    "![Shared mockup](~/Downloads/outside.png)",
    `![Beam revision](~/${project}/missing.png)`,
    `![Notes](~/${project}/notes.txt)`,
  ].join("\n\n");
  return { id, home, project, reply, reasons };
}

export async function showReply(state: TestState, page: Page, body: string) {
  await state.queue([body]);
  await prompt(page, "Show the picker mockups");
}

export async function revealImage(page: Page, alt: string) {
  await revealAcquired(
    page,
    `.otk-inline-image img[alt=${JSON.stringify(alt)}]`,
  );
  return page.locator(`.otk-inline-image img[alt=${JSON.stringify(alt)}]`);
}
