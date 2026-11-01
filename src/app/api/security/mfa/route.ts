import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { requireDashboardSession } from "@/lib/auth";
import { authCookieValue, DASHBOARD_SESSION_SECONDS, secretsMatch } from "@/lib/authcrypto";
import { clientIp } from "@/lib/rate-limit";
import { beginMfaEnrollment, clearLoginAttempts, confirmMfaEnrollment, dashboardSecurityConfigured, reserveLoginAttempt, securityState } from "@/lib/dashboard-security";

const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
function reply(body: object, status = 200) { return NextResponse.json(body, { status, headers }); }

export async function GET(req: Request) {
  try {
    const denied = await requireDashboardSession(req); if (denied) return denied;
    return reply({ configured: dashboardSecurityConfigured(), ...await securityState() });
  } catch { return reply({ error: "Security settings are temporarily unavailable." }, 503); }
}

export async function POST(req: Request) {
  try {
    const denied = await requireDashboardSession(req); if (denied) return denied;
    const password = process.env.MC_DASHBOARD_PASSWORD;
    if (!dashboardSecurityConfigured() || !password) return reply({ error: "Two-step sign-in is not configured." }, 503);
    const ip = clientIp(req);
    const limit = await reserveLoginAttempt(ip);
    if (!limit.allowed) {
      const res = reply({ error: "Too many attempts. Please try again later." }, 429);
      res.headers.set("Retry-After", String(limit.retryAfterSec)); return res;
    }
    const body = await req.json();
    if (typeof body.password !== "string" || !(await secretsMatch(body.password, password))) return reply({ error: "Password is incorrect." }, 401);
    if (body.action === "start") {
      const enrollment = await beginMfaEnrollment();
      if (!enrollment) return reply({ error: "Two-step sign-in is already enabled." }, 409);
      const qr = await QRCode.toDataURL(enrollment.uri, { width: 280, margin: 4, errorCorrectionLevel: "M" });
      await clearLoginAttempts(ip);
      return reply({ enrollmentId: enrollment.id, secret: enrollment.secret, qr, expiresIn: 600 });
    }
    if (body.action === "confirm" && typeof body.enrollmentId === "string" && typeof body.code === "string") {
      const result = await confirmMfaEnrollment(body.enrollmentId, body.code);
      if (!result) return reply({ error: "Code is incorrect, or setup expired. Start again if necessary." }, 401);
      await clearLoginAttempts(ip).catch(() => {});
      const res = reply({ enabled: true, recoveryCodes: result.recoveryCodes });
      res.cookies.set("mc_auth", await authCookieValue(password, result.epoch), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: DASHBOARD_SESSION_SECONDS });
      return res;
    }
    return reply({ error: "Invalid setup request." }, 400);
  } catch { return reply({ error: "Security settings are temporarily unavailable." }, 503); }
}
