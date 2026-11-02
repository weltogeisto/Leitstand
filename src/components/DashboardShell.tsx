"use client";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { NAV_LINKS, isActive } from "@/lib/nav";
import { WorkIcon, WorkMark } from "./WorkIcon";
import "./dashboard.css";

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.close(); }, [path]);
  if (path === "/login" || path === "/work") return <main>{children}</main>;
  const title = NAV_LINKS.find(l => isActive(path, l.href))?.label ?? "Workspace";
  function navigation(mobile = false) {
    return <>
      <div className="ds-brand"><Link href="/"><WorkMark/>Leitstand</Link>{mobile && <button aria-label="Close navigation" onClick={() => dialog.current?.close()}><WorkIcon name="close"/></button>}</div>
      <Link className="ds-new" href="/work" onClick={() => dialog.current?.close()}><WorkIcon name="plus"/>New conversation<span>↗</span></Link>
      <nav aria-label="Workspace navigation">{NAV_LINKS.map(l => <Link key={l.href} href={l.href} aria-current={isActive(path,l.href)?"page":undefined} onClick={() => dialog.current?.close()}>{l.href === "/work" ? <WorkIcon name="chat"/> : l.href === "/" ? <WorkIcon name="grid"/> : null}{l.label}</Link>)}</nav>
      <p className="ds-sidebar-note">Your workspace.<br/>Your agents, in view.</p>
    </>;
  }
  return <div className="dashboard-shell">
    <aside className="ds-sidebar">{navigation()}</aside>
    <div className="ds-content"><header className="ds-topbar"><button className="ds-menu" aria-label="Open navigation" onClick={() => dialog.current?.showModal()}><WorkIcon name="menu"/></button><Link className="ds-mobile-brand" href="/">Leitstand</Link><span className="ds-breadcrumb">Workspace <span>/</span> {title}</span><Link className="ds-work-link" href="/work"><WorkIcon name="chat"/>Open Work</Link></header><main className="ds-main">{children}</main></div>
    <dialog ref={dialog} className="ds-drawer" aria-label="Navigation" onClick={e => {if(e.target===e.currentTarget)dialog.current?.close();}}><div>{navigation(true)}</div></dialog>
  </div>;
}
