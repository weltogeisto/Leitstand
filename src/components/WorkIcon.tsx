import type { ReactNode } from "react";
type IconName = "menu" | "plus" | "close" | "arrow" | "folder" | "chat" | "grid" | "search" | "settings" | "help" | "code" | "plan" | "review" | "chevron" | "download" | "stop" | "monitor";
const paths: Record<IconName, ReactNode> = {
  menu: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, close: <path d="m6 6 12 12M18 6 6 18"/>,
  arrow: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>,
  chat: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z"/>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5"/><circle cx="16" cy="17" r="2.5"/></>,
  help: <><circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/></>,
  code: <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/>,
  plan: <><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></>,
  review: <><path d="M14 3H5v18h14V8Z"/><path d="M14 3v5h5m-11 6 3 3 5-6"/></>,
  chevron: <path d="m8 10 4 4 4-4"/>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  monitor: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></>,
};
export function WorkIcon({ name }: { name: IconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
export function WorkMark() {
  return <span className="work-mark" aria-hidden="true"><i/><i/><i/></span>;
}
