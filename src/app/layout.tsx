import type { Metadata } from "next";
import DashboardShell from "@/components/DashboardShell";
import "./globals.css";
export const metadata: Metadata = { title: "Leitstand", description: "Your agents and projects, in one place." };
export default function RootLayout({children}:{children:React.ReactNode}) { return <html lang="en"><body><DashboardShell>{children}</DashboardShell></body></html>; }
