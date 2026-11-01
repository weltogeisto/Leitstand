"use client";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { SiteNav } from "./SiteNav";
import { AttentionStrip } from "./AttentionStrip";
export default function DashboardShell({children}:{children:React.ReactNode}) {
  const path=usePathname();
  if(path==="/") return <main>{children}</main>;
  return <><header className="border-b border-white/10 bg-[#0a0f1c] sticky top-0 z-10"><div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3"><Link href="/" className="font-semibold tracking-wide">Leitstand</Link><div className="ml-auto"><AttentionStrip/></div><SiteNav/></div></header><main className="mx-auto max-w-6xl px-4 py-6">{children}</main><footer className="mx-auto max-w-6xl px-4 py-8 text-xs text-gray-500">Leitstand · <Link href="/">Back to the board</Link></footer></>;
}
