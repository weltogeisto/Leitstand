import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import { sql, withTransaction, type Row } from "./db";
import { authCookieEpoch, verifyAuthCookie, secretsMatch } from "./authcrypto";
import { loginLimiter } from "./login-limiter";

export function dashboardSecurityConfigured(): boolean { return process.env.MC_MFA_ENABLED === "1"; }

function key(): Buffer {
  const value = process.env.MC_MFA_ENCRYPTION_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Dashboard security key is not configured");
  return Buffer.from(value, "hex");
}

export function encryptMfaSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from("leitstand-mfa-v1"));
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

export function decryptMfaSecret(value: string): string {
  const blob = Buffer.from(value, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key(), blob.subarray(0, 12));
  decipher.setAAD(Buffer.from("leitstand-mfa-v1"));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
}

function hash(value: string): string { return createHmac("sha256", key()).update(value).digest("hex"); }
function totp(secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ issuer: "Leitstand", label: "Dashboard", algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}

export function validTotpCounter(secret: string, code: string, lastCounter: number, timestamp = Date.now()): number | null {
  const token = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(token)) return null;
  const delta = totp(secret).validate({ token, window: 1, timestamp });
  if (delta === null) return null;
  const counter = Math.floor(timestamp / 30_000) + delta;
  return counter > lastCounter ? counter : null;
}

export async function securityState(): Promise<{ enabled: boolean; epoch: string; recoveryCodes: number }> {
  if (!dashboardSecurityConfigured()) return { enabled: false, epoch: "0", recoveryCodes: 0 };
  const rows = await sql()`select enabled, session_epoch, cardinality(recovery_hashes) as recovery_count from dashboard_auth where id = true`;
  if (!rows[0]) throw new Error("Dashboard security state is unavailable");
  return { enabled: rows[0].enabled, epoch: rows[0].session_epoch, recoveryCodes: Number(rows[0].recovery_count) };
}

export async function verifyDashboardCookie(cookie: string, password: string): Promise<boolean> {
  if (!(await verifyAuthCookie(cookie, password))) return false;
  const state = await securityState();
  return authCookieEpoch(cookie) === state.epoch;
}

/** An atomic shared counter covers login, OAuth approval and enrollment. */
export async function reserveLoginAttempt(ip: string): Promise<{ allowed: boolean; retryAfterSec: number }> {
  if (!dashboardSecurityConfigured()) {
    const result = loginLimiter.check(ip);
    if (result.allowed) loginLimiter.fail(ip);
    return result;
  }
  const bucket = hash(`login:${ip}`);
  const db = sql();
  await db`delete from dashboard_login_limits where bucket in (select bucket from dashboard_login_limits where expires_at < now() - interval '1 hour' limit 1000)`;
  const rows = await db`
    insert into dashboard_login_limits(bucket, attempts, expires_at) values (${bucket}, 1, now() + interval '10 minutes')
    on conflict (bucket) do update set
      attempts = case when dashboard_login_limits.expires_at <= now() then 1 else least(dashboard_login_limits.attempts + 1, 6) end,
      expires_at = case when dashboard_login_limits.expires_at <= now() then now() + interval '10 minutes' else dashboard_login_limits.expires_at end
    returning attempts, greatest(1, ceil(extract(epoch from expires_at - now()))) as retry_after`;
  if (!rows[0]) throw new Error("Login limit is unavailable");
  return { allowed: Number(rows[0].attempts) <= 5, retryAfterSec: Number(rows[0].retry_after) };
}

export async function clearLoginAttempts(ip: string): Promise<void> {
  if (!dashboardSecurityConfigured()) { loginLimiter.reset(ip); return; }
  await sql()`delete from dashboard_login_limits where bucket = ${hash(`login:${ip}`)}`;
}

async function consumeFactor(row: Row, code: string): Promise<{ counter?: number; hashes?: string[] } | null> {
  const normalized = code.replace(/[-\s]/g, "").toLowerCase();
  if (/^[a-f0-9]{20}$/.test(normalized)) {
    const candidate = hash(`recovery:${normalized}`);
    const hashes: string[] = row.recovery_hashes ?? [];
    let index = -1;
    for (let i = 0; i < hashes.length; i++) if (await secretsMatch(candidate, hashes[i])) index = i;
    return index < 0 ? null : { hashes: hashes.filter((_, i) => i !== index) };
  }
  const counter = validTotpCounter(decryptMfaSecret(row.secret_encrypted), code, Number(row.last_counter));
  return counter === null ? null : { counter };
}

export async function checkSecondFactor(code: string): Promise<{ ok: boolean; epoch: string }> {
  if (!dashboardSecurityConfigured()) return { ok: true, epoch: "0" };
  return withTransaction(async (db) => {
    const row = (await db`select * from dashboard_auth where id = true for update`)[0];
    if (!row) throw new Error("Dashboard security state is unavailable");
    if (!row.enabled) return { ok: true, epoch: row.session_epoch };
    const accepted = await consumeFactor(row, code);
    if (!accepted) return { ok: false, epoch: row.session_epoch };
    if (accepted.counter !== undefined) await db`update dashboard_auth set last_counter = ${accepted.counter}, updated_at = now() where id = true`;
    if (accepted.hashes) await db`update dashboard_auth set recovery_hashes = ${accepted.hashes}, updated_at = now() where id = true`;
    return { ok: true, epoch: row.session_epoch };
  });
}

export async function beginMfaEnrollment(): Promise<{ id: string; secret: string; uri: string } | null> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const id = randomBytes(24).toString("base64url");
  const encrypted = encryptMfaSecret(secret);
  const rows = await sql()`update dashboard_auth set pending_secret = ${encrypted}, pending_id = ${id}, pending_expires = now() + interval '10 minutes', updated_at = now() where id = true and enabled = false returning id`;
  return rows.length ? { id, secret, uri: totp(secret).toString() } : null;
}

export async function confirmMfaEnrollment(id: string, code: string): Promise<{ epoch: string; recoveryCodes: string[] } | null> {
  return withTransaction(async (db) => {
    const row = (await db`select *, pending_expires > now() as pending_valid from dashboard_auth where id = true for update`)[0];
    if (!row || row.enabled || !row.pending_valid || !row.pending_secret || !row.pending_id || !(await secretsMatch(id, row.pending_id))) return null;
    const counter = validTotpCounter(decryptMfaSecret(row.pending_secret), code, -1);
    if (counter === null) return null;
    const rawCodes = Array.from({ length: 10 }, () => randomBytes(10).toString("hex"));
    const hashes = rawCodes.map((value) => hash(`recovery:${value}`));
    const epoch = randomBytes(24).toString("base64url");
    await db`update dashboard_auth set enabled = true, secret_encrypted = pending_secret, session_epoch = ${epoch}, last_counter = ${counter}, recovery_hashes = ${hashes}, pending_secret = null, pending_id = null, pending_expires = null, updated_at = now() where id = true`;
    return { epoch, recoveryCodes: rawCodes.map((value) => value.match(/.{1,5}/g)!.join("-")) };
  });
}
