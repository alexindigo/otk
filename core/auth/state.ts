// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { stringify } from "@std/toml";
import type { ServiceConfig } from "../config/schema.ts";
import { statePath } from "../config/loader.ts";
import { hashPassword, LocalAuth } from "./local.ts";
export class AuthState {
  local: LocalAuth | null;
  #settingUp = false;
  constructor(readonly cfg: ServiceConfig) {
    if (!["", "none", "password", "totp"].includes(cfg.auth.type)) {
      throw new Error("Invalid auth.type");
    }
    if (!["strict", "none"].includes(cfg.auth.cookiesamesite)) {
      throw new Error("Invalid auth.cookiesamesite");
    }
    this.local = cfg.auth.type === "password" || cfg.auth.type === "totp"
      ? new LocalAuth(cfg.auth)
      : null;
  }
  get setupRequired(): boolean {
    return this.cfg.auth.type === "";
  }
  get cookieName(): string {
    return this.cfg.auth.cookiename || `otk_${this.cfg.server.port}`;
  }
  async setup(
    input: { type: string; username?: string; password?: string },
  ): Promise<void> {
    if (!this.setupRequired || this.#settingUp) {
      throw new Error("already_configured");
    }
    if (!["none", "password"].includes(input.type)) {
      throw new Error(
        "Setup supports none or password; configure TOTP in the operator overlay",
      );
    }
    if (
      input.type === "password" && (!input.username?.trim() || !input.password)
    ) throw new Error("Username and password required");
    this.#settingUp = true;
    try {
      const stored = {
        type: input.type,
        username: input.username?.trim().toLowerCase() || "",
        password: input.type === "password"
          ? await hashPassword(input.password!)
          : "",
        secretkey: Array.from(
          crypto.getRandomValues(new Uint8Array(32)),
          (b) => b.toString(16).padStart(2, "0"),
        ).join(""),
      };
      const dir = statePath(this.cfg);
      await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
      await Deno.chmod(dir, 0o700);
      const file = await Deno.open(join(dir, "auth.toml"), {
        createNew: true,
        write: true,
        mode: 0o600,
      });
      try {
        const bytes = new TextEncoder().encode(stringify(stored));
        let written = 0;
        while (written < bytes.length) {
          written += await file.write(bytes.subarray(written));
        }
        await file.sync();
      } finally {
        file.close();
      }
      Object.assign(this.cfg.auth, stored);
      this.local = stored.type === "password"
        ? new LocalAuth(this.cfg.auth)
        : null;
    } catch (e) {
      if (e instanceof Deno.errors.AlreadyExists) {
        throw new Error("already_configured");
      }
      throw e;
    } finally {
      this.#settingUp = false;
    }
  }
  token(request: Request): string | null {
    for (const pair of (request.headers.get("cookie") || "").split(";")) {
      const [name, ...value] = pair.trim().split("=");
      if (name === this.cookieName) return value.join("=");
    }
    return null;
  }
  async authenticated(request: Request): Promise<boolean> {
    if (this.setupRequired) return false;
    if (!this.local) return true;
    try {
      await this.local.validateToken(this.token(request));
      return true;
    } catch {
      return false;
    }
  }
  cookie(token: string, clear = false): string {
    return `${this.cookieName}=${token}; HttpOnly; Path=/; SameSite=${
      this.cfg.auth.cookiesamesite === "none" ? "None; Secure" : "Strict"
    }; Max-Age=${clear ? 0 : this.cfg.auth.sessionexpirydays * 86_400}`;
  }
}
