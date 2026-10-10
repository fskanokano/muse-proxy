// 后台鉴权: 单管理员 (密码来自环境变量) + HMAC 自签 token (8h 有效)。
// 与 sse-gateway 同风味、零依赖 (node:crypto 自包含)。
import crypto from "node:crypto";
import { env } from "./config.js";

const TOKEN_TTL_MS = 8 * 3600_000;

function timingSafeEqual(a: string, b: string): boolean {
  const la = Buffer.byteLength(a);
  const lb = Buffer.byteLength(b);
  const bufA = Buffer.alloc(Math.max(la, lb), 0);
  const bufB = Buffer.alloc(Math.max(la, lb), 0);
  bufA.write(a);
  bufB.write(b);
  return crypto.timingSafeEqual(bufA, bufB) && la === lb;
}

export function verifyPassword(provided: string): boolean {
  if (!env.adminPassword || !provided) return false;
  return timingSafeEqual(provided, env.adminPassword);
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function signToken(): string {
  const body = b64url(Buffer.from(JSON.stringify({ sub: "admin", exp: Date.now() + TOKEN_TTL_MS })));
  const sig = b64url(crypto.createHmac("sha256", env.adminPassword).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token: string): boolean {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || !env.adminPassword) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = b64url(crypto.createHmac("sha256", env.adminPassword).update(body).digest());
  if (!timingSafeEqual(sig, expect)) return false;
  try {
    const payload = JSON.parse(unb64url(body).toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" && payload.exp > Date.now();
  } catch {
    return false;
  }
}

export function bearerToken(headers: Headers): string {
  // 网关挂载时 Authorization 头要让给网关边缘钥, 后台 token 改走 x-admin-key;
  // 直连时两者任一皆可。
  const admin = headers.get("x-admin-key") ?? "";
  if (admin) return admin;
  const h = headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}
