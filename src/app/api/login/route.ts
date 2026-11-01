import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { authCookieValue, DASHBOARD_SESSION_SECONDS, validRequestOrigin, secretsMatch } from "@/lib/authcrypto";
import { clientIp } from "@/lib/rate-limit";
import { reserveLoginAttempt, clearLoginAttempts, checkSecondFactor } from "@/lib/dashboard-security";

export async function POST(req: Request) {
  if (!validRequestOrigin(req)) return apiError("unauthorized");
  const password = process.env.MC_DASHBOARD_PASSWORD;
  if (!password) {
    if (process.env.MC_MFA_ENABLED === "1" || (process.env.NODE_ENV === "production" && process.env.DATABASE_URL)) {
      return apiError("internal_error", { status: 503, message: "Sign-in is not configured." });
    }
    return NextResponse.json({ ok: true, note: "no password configured" });
  }

  const ip = clientIp(req);
  let limit;
  try { limit = await reserveLoginAttempt(ip); } catch { return apiError("internal_error", { status: 503, message: "Sign-in is temporarily unavailable." }); }
  const { allowed, retryAfterSec } = limit;
  if (!allowed) {
    return apiError("rate_limited", { headers: { "Retry-After": String(retryAfterSec) } });
  }

  let submitted = "";
  let code = "";
  try {
    const body = (await req.json()) as { password?: unknown; code?: unknown };
    submitted = typeof body.password === "string" ? body.password : "";
    code = typeof body.code === "string" ? body.code : "";
  } catch {
    return apiError("invalid_json", { message: "invalid request" });
  }

  if (!(await secretsMatch(submitted, password))) {
    return apiError("unauthorized", {
      message: "wrong password",
      fix: "Check the dashboard password and try again.",
    });
  }

  let second;
  try {
    second = await checkSecondFactor(code);
    if (!second.ok) return apiError("unauthorized", { message: "The verification code is incorrect or already used." });
    await clearLoginAttempts(ip);
  } catch { return apiError("internal_error", { status: 503, message: "Sign-in is temporarily unavailable." }); }

  const res = NextResponse.json({ ok: true });
  res.cookies.set("mc_auth", await authCookieValue(password, second.epoch), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: DASHBOARD_SESSION_SECONDS,
  });
  return res;
}
