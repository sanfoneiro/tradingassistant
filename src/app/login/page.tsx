"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const router = useRouter();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr("Wrong passphrase.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <p className="mb-6 text-center font-mono text-sm text-faint">
        trading<span className="text-acc">assistant</span>
      </p>
      <form onSubmit={submit} className="space-y-3">
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          placeholder="Passphrase"
          className="w-full rounded-lg border border-line bg-panel px-3 py-2.5 text-sm outline-none placeholder:text-faint focus:border-acc/60"
        />
        <button
          disabled={busy || !pw}
          className="w-full rounded-lg border border-acc/50 bg-acc/10 px-4 py-2.5 text-sm text-acc transition hover:bg-acc/20 disabled:opacity-40"
        >
          {busy ? "…" : "Enter"}
        </button>
        {err && <p className="text-center text-sm text-down">{err}</p>}
      </form>
    </div>
  );
}
