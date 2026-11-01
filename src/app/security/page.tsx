"use client";
import { useEffect, useState } from "react";

export default function SecurityPage() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<{ enrollmentId: string; secret: string; qr: string } | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/security/mfa", { cache: "no-store" }).then(async (res) => {
      if (res.status === 401) { window.location.href = "/login?next=/security"; return; }
      const data = await res.json();
      if (!res.ok || !data.configured) throw new Error(data.error || "Two-step sign-in is not configured.");
      if (!cancelled) setEnabled(data.enabled);
    }).catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const res = await fetch("/api/security/mfa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: enrollment ? "confirm" : "start", password, code, enrollmentId: enrollment?.enrollmentId }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Setup could not be completed.");
      if (data.enabled) { setEnabled(true); setRecovery(data.recoveryCodes); setEnrollment(null); setPassword(""); setCode(""); }
      else setEnrollment(data);
    } catch (e) { setError(e instanceof Error ? e.message : "Setup could not be completed."); }
    finally { setBusy(false); }
  }
  function downloadRecovery() {
    const blob = new Blob(["Leitstand recovery codes\nEach code can be used once, together with your password.\n\n" + recovery.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = "leitstand-recovery-codes.txt"; a.click(); URL.revokeObjectURL(url);
  }
  const inputClass = "w-full rounded-lg border border-white/20 bg-[#0a0f1c] px-3 py-2 text-white";
  return <section className="mx-auto max-w-md rounded-xl border border-white/10 bg-[#101828] p-6 text-gray-100">
    <h1 className="mb-3 text-xl font-semibold">Two-step sign-in</h1>
    {error && <p role="alert" className="mb-4 text-red-300">{error}</p>}
    {enabled === null && !error && <p>Loading security settings…</p>}
    {enabled === true && <p className="mb-4 text-green-300">Google Authenticator is enabled.</p>}
    {enabled === false && <form onSubmit={submit} className="space-y-4">
      <p>Add Leitstand to Google Authenticator. Setup becomes active after you verify a code.</p>
      <label className="block">Dashboard password<input className={inputClass} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {enrollment && <>
        <p>In Google Authenticator, tap <strong>+</strong>, then <strong>Scan a QR code</strong>.</p>
        <img src={enrollment.qr} alt="Scan this private setup QR code with Google Authenticator" width={280} height={280} className="mx-auto max-w-full rounded-lg" />
        <details><summary className="cursor-pointer">Enter a setup key instead</summary><p className="mt-2 break-all rounded bg-black/20 p-3 font-mono select-all">{enrollment.secret}</p><p className="text-sm">Account: Leitstand · Key type: Time based</p></details>
        <label className="block">Six-digit code<input className={inputClass} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></label>
        <p className="text-sm text-gray-400">This setup expires after 10 minutes.</p>
        <button type="button" disabled={busy} onClick={() => { setEnrollment(null); setCode(""); setError(""); }} className="text-sm underline">Start again</button>
      </>}
      <button className="w-full rounded-lg bg-[#f44800] px-4 py-2 font-semibold disabled:opacity-50" disabled={busy || !password}>{busy ? "Checking…" : enrollment ? "Verify and enable" : "Set up Google Authenticator"}</button>
    </form>}
    {recovery.length > 0 && <div className="space-y-4">
      <h2 className="font-semibold">Save your recovery codes</h2><p>Keep these somewhere private. Each code can replace an authenticator code once if you lose your phone. These codes are shown only now.</p>
      <pre className="overflow-auto rounded-lg bg-black/20 p-3 text-sm select-all">{recovery.join("\n")}</pre>
      <button onClick={downloadRecovery} className="rounded-lg bg-[#f44800] px-4 py-2 font-semibold">Download recovery codes</button>
    </div>}
    <a href="/" className="mt-6 inline-block text-sm text-gray-300 underline">Back to Leitstand</a>
  </section>;
}
