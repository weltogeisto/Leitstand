import type { Metadata } from "next";
import DashboardShell from "@/components/DashboardShell";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireDashboardSession } from "@/lib/auth";
import "./globals.css";
export const metadata: Metadata = { title: "Leitstand", description: "Your agents and projects, in one place." };
export const dynamic = "force-dynamic";
export default async function RootLayout({children}:{children:React.ReactNode}) {
  if (process.env.MC_MFA_ENABLED === "1") {
    const requestHeaders = await headers();
    const path = requestHeaders.get("x-leitstand-path") || "/";
    if (path !== "/login") {
      const denied = await requireDashboardSession(new Request("https://leitstand.invalid/", { headers: requestHeaders }));
      if (denied) redirect(`/login?next=${encodeURIComponent(path)}`);
    }
  }
  return <html lang="en"><body><DashboardShell>{children}</DashboardShell></body></html>;
}
