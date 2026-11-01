import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as OTPAuth from "otpauth";
import { setSqlForTests, type Row } from "../../src/lib/db";
import { authCookieValue } from "../../src/lib/authcrypto";
import { beginMfaEnrollment, checkSecondFactor, confirmMfaEnrollment, decryptMfaSecret, reserveLoginAttempt, verifyDashboardCookie } from "../../src/lib/dashboard-security";
import { POST as login } from "../../src/app/api/login/route";
import { POST as setup } from "../../src/app/api/security/mfa/route";
import { POST as authorize } from "../../src/app/oauth/authorize/route";

const env = process.env as Record<string, string | undefined>;
const names = ["MC_MFA_ENABLED", "MC_MFA_ENCRYPTION_KEY", "MC_DASHBOARD_PASSWORD", "MC_COOKIE_SECRET", "MC_TOKEN", "DATABASE_URL"];
let saved: (string | undefined)[];
let row: Row;
let attempts: number;
let now: number;
let codesMinted: number;
const realNow = Date.now;
beforeEach(() => {
  saved = names.map((n) => env[n]);
  env.MC_MFA_ENABLED = "1"; env.MC_MFA_ENCRYPTION_KEY = "ab".repeat(32);
  env.MC_DASHBOARD_PASSWORD = "dashboard-test-password"; env.MC_COOKIE_SECRET = "test-session-signing-key";
  delete env.MC_TOKEN;
  now = 1793550000000; Date.now = () => now;
  attempts = 0;
  codesMinted = 0;
  row = { enabled: false, session_epoch: "0", last_counter: -1, recovery_hashes: [], pending_secret: null };
  setSqlForTests(async (strings, ...values) => {
    const q = strings.join("?").replace(/\s+/g, " ").trim().toLowerCase();
    if (["begin", "commit", "rollback"].includes(q)) return [];
    if (q.includes("from oauth_clients")) return [{ client_id: "mfa-test", client_name: "Test client", redirect_uris: ["https://client.test/callback"] }];
    if (q.includes("insert into oauth_codes")) { codesMinted++; return []; }
    if (q.startsWith("select enabled")) return [{ ...row, recovery_count: row.recovery_hashes.length }];
    if (q.startsWith("select *")) return [{ ...row, pending_valid: row.pending_expires > now }];
    if (q.includes("insert into dashboard_login_limits")) return [{ attempts: ++attempts, retry_after: 600 }];
    if (q.startsWith("delete from dashboard_login_limits")) { if (q.includes("where bucket =")) attempts = 0; return []; }
    if (q.includes("set pending_secret")) {
      if (row.enabled) return [];
      row.pending_secret = values[0]; row.pending_id = values[1]; row.pending_expires = now + 600000;
      return [{ id: true }];
    }
    if (q.includes("set enabled = true")) {
      row.enabled = true; row.secret_encrypted = row.pending_secret; row.session_epoch = values[0];
      row.last_counter = values[1]; row.recovery_hashes = values[2]; row.pending_secret = null; row.pending_id = null;
      return [];
    }
    if (q.includes("set last_counter")) { row.last_counter = values[0]; return []; }
    if (q.includes("set recovery_hashes")) { row.recovery_hashes = values[0]; return []; }
    throw new Error(`Unexpected SQL in MFA test: ${q}`);
  });
});
afterEach(() => {
  Date.now = realNow; setSqlForTests(null);
  names.forEach((n, i) => { if (saved[i] === undefined) delete env[n]; else env[n] = saved[i]; });
});

function code(secret: string) { return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({ timestamp: now }); }
async function enroll() {
  const pending = await beginMfaEnrollment(); assert.ok(pending);
  const enabled = await confirmMfaEnrollment(pending.id, code(pending.secret)); assert.ok(enabled);
  return { pending, enabled };
}

describe("dashboard MFA enrollment and authentication", () => {
  it("encrypts enrollment, rejects tampering and requires a valid unexpired proof", async () => {
    const pending = await beginMfaEnrollment(); assert.ok(pending);
    assert.notEqual(row.pending_secret, pending.secret);
    assert.equal(decryptMfaSecret(row.pending_secret), pending.secret);
    const corrupt = Buffer.from(row.pending_secret, "base64url"); corrupt[20] ^= 1;
    assert.throws(() => decryptMfaSecret(corrupt.toString("base64url")));
    assert.equal(await confirmMfaEnrollment("wrong-id", code(pending.secret)), null);
    assert.equal(await confirmMfaEnrollment(pending.id, "invalid"), null);
    now += 600001;
    assert.equal(await confirmMfaEnrollment(pending.id, code(pending.secret)), null);
    assert.equal(row.enabled, false);
  });

  it("revokes pre-enrollment cookies and accepts each TOTP or recovery code once", async () => {
    const old = await authCookieValue(env.MC_DASHBOARD_PASSWORD!);
    const { pending, enabled } = await enroll();
    assert.equal(await verifyDashboardCookie(old, env.MC_DASHBOARD_PASSWORD!), false);
    const current = await authCookieValue(env.MC_DASHBOARD_PASSWORD!, enabled.epoch);
    assert.equal(await verifyDashboardCookie(current, env.MC_DASHBOARD_PASSWORD!), true);
    assert.equal((await checkSecondFactor(code(pending.secret))).ok, false);
    now += 30000;
    assert.equal((await checkSecondFactor(code(pending.secret))).ok, true);
    assert.equal((await checkSecondFactor(code(pending.secret))).ok, false);
    assert.equal(enabled.recoveryCodes.length, 10);
    assert.ok(!JSON.stringify(row.recovery_hashes).includes(enabled.recoveryCodes[0].replace(/-/g, "")));
    assert.equal((await checkSecondFactor(enabled.recoveryCodes[0])).ok, true);
    assert.equal((await checkSecondFactor(enabled.recoveryCodes[0])).ok, false);
    assert.equal(row.recovery_hashes.length, 9);
  });

  it("does not let a password-only login bypass an enrolled factor", async () => {
    const { pending } = await enroll();
    const req = (otp = "") => new Request("https://example.test/api/login", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "mfa-login-test" }, body: JSON.stringify({ password: env.MC_DASHBOARD_PASSWORD, code: otp }) });
    assert.equal((await login(req())).status, 401);
    now += 30000;
    const success = await login(req(code(pending.secret)));
    assert.equal(success.status, 200);
    const cookie = /mc_auth=([^;]+)/.exec(success.headers.get("set-cookie")!)![1];
    assert.equal(await verifyDashboardCookie(cookie, env.MC_DASHBOARD_PASSWORD!), true);
    assert.equal((await login(req(code(pending.secret)))).status, 401);
  });

  it("denies bearer enrollment and cross-origin setup, even with a valid cookie", async () => {
    const bearer = new Request("https://example.test/api/security/mfa", { method: "POST", headers: { authorization: "Bearer test-token" }, body: "{}" });
    assert.equal((await setup(bearer)).status, 401);
    const cookie = await authCookieValue(env.MC_DASHBOARD_PASSWORD!);
    const cross = new Request("https://example.test/api/security/mfa", { method: "POST", headers: { cookie: `mc_auth=${cookie}`, origin: "https://attacker.test" }, body: "{}" });
    assert.equal((await setup(cross)).status, 401);
  });

  it("shares and enforces the login attempt budget", async () => {
    for (let i = 0; i < 5; i++) assert.equal((await reserveLoginAttempt("test-ip")).allowed, true);
    assert.equal((await reserveLoginAttempt("test-ip")).allowed, false);
  });

  it("requires the second factor for OAuth approval and rejects a pre-enrollment session", async () => {
    env.DATABASE_URL = "postgres://test.invalid/mfa";
    const old = await authCookieValue(env.MC_DASHBOARD_PASSWORD!);
    const { pending } = await enroll();
    const req = (code = "") => new Request("https://example.test/oauth/authorize", {
      method: "POST", headers: { cookie: `mc_auth=${old}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ response_type: "code", client_id: "mfa-test", redirect_uri: "https://client.test/callback", code_challenge: "a".repeat(43), code_challenge_method: "S256", password: env.MC_DASHBOARD_PASSWORD!, code }),
    });
    assert.equal((await authorize(req())).headers.get("location"), null);
    assert.equal(codesMinted, 0);
    now += 30000;
    const response = await authorize(req(code(pending.secret)));
    assert.equal(response.status, 302);
    assert.equal(codesMinted, 1);
    const cookie = /mc_auth=([^;]+)/.exec(response.headers.get("set-cookie")!)![1];
    assert.equal(await verifyDashboardCookie(cookie, env.MC_DASHBOARD_PASSWORD!), true);
  });

  it("fails closed when the password or security store is unavailable", async () => {
    const password = env.MC_DASHBOARD_PASSWORD;
    delete env.MC_DASHBOARD_PASSWORD;
    assert.equal((await login(new Request("https://example.test/api/login", { method: "POST", body: "{}" }))).status, 503);
    env.MC_DASHBOARD_PASSWORD = password;
    setSqlForTests(async () => { throw new Error("offline"); });
    assert.equal((await login(new Request("https://example.test/api/login", { method: "POST", body: JSON.stringify({ password }) }))).status, 503);
  });
});
