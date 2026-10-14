// SPDX-License-Identifier: LGPL-3.0-only
import { jwtVerify, SignJWT } from "jose";
import { authenticator } from "otplib";
import { encodeBase32 } from "@std/encoding/base32";
import type { ServiceConfig } from "../config/schema.ts";
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0"))
    .join("");
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}
async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    256,
  );
}
export async function hashPassword(
  password: string,
  iterations = 100_000,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2_sha256$${iterations}$${hex(salt)}$${
    hex(await derive(password, salt, iterations))
  }`;
}
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const match = /^pbkdf2_sha256\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(
    stored,
  );
  if (!match) return false;
  const iterations = Number(match[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1) return false;
  const salt = new Uint8Array(
    match[2].match(/../g)!.map((p) => parseInt(p, 16)),
  );
  return timingSafeEqual(
    hex(await derive(password, salt, iterations)),
    match[3],
  );
}
export class LocalAuth {
  #lastStep = -Infinity;
  readonly username: string;
  constructor(
    readonly settings: ServiceConfig["auth"],
    readonly now: () => number = () => Date.now(),
  ) {
    this.username = settings.username.toLowerCase();
    if (!this.username || !settings.password || !settings.secretkey) {
      throw new Error(
        "Authentication requires username, password and secretkey",
      );
    }
    if (settings.type === "totp" && !settings.totpkey) {
      throw new Error("TOTP requires OTK_AUTH_TOTPKEY");
    }
  }
  async login(username: string, supplied: string): Promise<string> {
    let password = supplied, acceptedStep: number | undefined;
    if (this.settings.type === "totp") {
      const code = supplied.slice(-6);
      password = supplied.slice(0, -6);
      const otp = authenticator.clone();
      otp.options = { window: 1, epoch: this.now() };
      const secret = encodeBase32(encoder.encode(this.settings.totpkey))
        .replace(/=+$/, "");
      const delta = /^\d{6}$/.test(code) ? otp.checkDelta(code, secret) : null;
      if (delta === null) throw new Error("Incorrect login credentials");
      acceptedStep = Math.floor(this.now() / 30_000) + delta;
    }
    const userOK = timingSafeEqual(this.username, username.toLowerCase());
    const passwordOK = this.settings.password.startsWith("pbkdf2_sha256$")
      ? await verifyPassword(password, this.settings.password)
      : timingSafeEqual(this.settings.password, password);
    if (
      !userOK || !passwordOK ||
      (acceptedStep !== undefined && acceptedStep <= this.#lastStep)
    ) throw new Error("Incorrect login credentials");
    if (acceptedStep !== undefined) this.#lastStep = acceptedStep;
    const now = Math.floor(this.now() / 1000);
    return new SignJWT({ sub: this.username }).setProtectedHeader({
      alg: "HS256",
    }).setIssuedAt(now)
      .setExpirationTime(now + this.settings.sessionexpirydays * 86_400).sign(
        encoder.encode(this.settings.secretkey),
      );
  }
  async validateToken(token: string | null): Promise<void> {
    if (!token) throw new Error("Missing cookie");
    const { payload } = await jwtVerify(
      token,
      encoder.encode(this.settings.secretkey),
      { algorithms: ["HS256"], currentDate: new Date(this.now()) },
    );
    if (payload.sub !== this.username) throw new Error("Wrong subject");
  }
}
