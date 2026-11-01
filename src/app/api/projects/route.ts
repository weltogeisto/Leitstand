import { NextResponse } from "next/server";
import { enforceApi } from "@/lib/auth";

export async function GET(req: Request) {
  const denied = await enforceApi(req);
  if (denied) return denied;
  try {
    const owner = process.env.LEITSTAND_GITHUB_OWNER || "weltogeisto";
    if (!/^[a-zA-Z0-9-]+$/.test(owner)) throw new Error("Invalid repository owner");
    const res = await fetch(`https://api.github.com/users/${owner}/repos?per_page=100&sort=pushed`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Leitstand" }, next: { revalidate: 900 },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const rows = await res.json() as Array<{ name: string; full_name: string; description: string | null; html_url: string; homepage: string | null; language: string | null; pushed_at: string; archived: boolean; fork: boolean; open_issues_count: number }>;
    return NextResponse.json({ projects: rows.map(r => ({ name: r.name, repo: r.full_name,
      description: r.name.toLowerCase() === "leitstand" ? "Your agents, work, and repositories in one place." : r.description, url: r.html_url, language: r.language,
      pushed_at: r.pushed_at, archived: r.archived, fork: r.fork, open_items: r.open_issues_count })),
      generated_at: new Date().toISOString(), source: "GitHub public repositories", truncated: rows.length === 100 });
  } catch {
    return NextResponse.json({ error: "Repository data is temporarily unavailable." }, { status: 503 });
  }
}
