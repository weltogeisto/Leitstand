import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { authCookieValue, verifyAuthCookie, validRequestOrigin, DASHBOARD_SESSION_SECONDS } from "../../src/lib/authcrypto";
import { resolveApiAccess, requireDashboardSession } from "../../src/lib/auth";

const env = process.env as Record<string, string | undefined>;
const saved = { password: env.MC_DASHBOARD_PASSWORD, secret: env.MC_COOKIE_SECRET, token: env.MC_TOKEN };
const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
  for (const [key, value] of Object.entries({ MC_DASHBOARD_PASSWORD: saved.password, MC_COOKIE_SECRET: saved.secret, MC_TOKEN: saved.token })) {
    if (value === undefined) delete env[key]; else env[key] = value;
  }
});

describe("dashboard session boundary", () => {
  it("issues different cookies and rejects tampering, password changes and key rotation", async () => {
    env.MC_COOKIE_SECRET = "first-signing-key";
    const cookie = await authCookieValue("password");
    assert.notEqual(cookie, await authCookieValue("password"));
    assert.equal(await verifyAuthCookie(cookie, "password"), true);
    assert.equal(await verifyAuthCookie(cookie, "different"), false);
    assert.equal(await verifyAuthCookie(cookie.slice(0, -1), "password"), false);
    const parts = cookie.split(".");
    parts[1] = String(Number(parts[1]) + 1);
    assert.equal(await verifyAuthCookie(parts.join("."), "password"), false);
    env.MC_COOKIE_SECRET = "rotated-signing-key";
    assert.equal(await verifyAuthCookie(cookie, "password"), false);
    assert.equal(await verifyAuthCookie("a".repeat(64), "password"), false);
  });

  it("rejects an expired cookie through both API and operator guards", async () => {
    env.MC_DASHBOARD_PASSWORD = "password";
    delete env.MC_TOKEN;
    const start = 1793550000000;
    Date.now = () => start;
    const cookie = await authCookieValue("password");
    const req = new Request("https://example.test/api/tasks", { headers: { cookie: `mc_auth=${cookie}` } });
    assert.equal((await resolveApiAccess(req)).ok, true);
    Date.now = () => start + DASHBOARD_SESSION_SECONDS * 1000;
    assert.equal((await resolveApiAccess(req)).ok, false);
    assert.equal((await requireDashboardSession(req))?.status, 401);
    Date.now = () => start - 60_000;
    assert.equal(await verifyAuthCookie(cookie, "password"), false);
  });

  it("refuses cross-origin cookie-authenticated writes", async () => {
    env.MC_DASHBOARD_PASSWORD = "password";
    delete env.MC_TOKEN;
    const cookie = await authCookieValue("password");
    const request = (origin: string) => new Request("https://example.test/api/tasks", {
      method: "POST", headers: { cookie: `mc_auth=${cookie}`, origin },
    });
    assert.equal((await resolveApiAccess(request("https://example.test"))).ok, true);
    assert.equal((await resolveApiAccess(request("https://attacker.test"))).ok, false);
    assert.equal((await requireDashboardSession(request("https://attacker.test")))?.status, 401);
    assert.equal(validRequestOrigin(new Request("https://example.test/api/tasks", { method: "POST", headers: { origin: "null" } })), false);
    assert.equal(validRequestOrigin(new Request("https://example.test/api/tasks", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })), false);
  });
});
