"use client";

import { useState, useCallback, useEffect } from "react";

type Check = {
  ok: boolean;
  computedNetPl: number;
  computedSlValue: number | null;
  problems: string[];
};

type Row = {
  symbol: string;
  side: "long" | "short";
  qty: number;
  openPrice: number;
  currentPrice: number;
  slPrice: number | null;
  tpPrice: number | null;
  fee: number;
  netPl: number;
  slValue: number | null;
  check: Check;
};

type Result = {
  ok: boolean;
  account: { label: string; balance: number; equity: number };
  verdict: { positions: number; verified: number; rejected: number; problems: string[] };
  positions: Row[];
  notes: string | null;
  unreadable: boolean;
};

const MEDIA = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const n = (x: number | null, d = 2) => (x == null ? "—" : x.toFixed(d));

export default function UploadForm() {
  const [preview, setPreview] = useState<string | null>(null);
  const [payload, setPayload] = useState<{ image: string; mediaType: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const take = useCallback((file: File) => {
    if (!MEDIA.includes(file.type)) {
      setError(`${file.type || "that file"} is not an image the reader accepts`);
      return;
    }
    setError(null);
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      setPreview(url);
      setPayload({ image: url.split(",")[1] ?? "", mediaType: file.type });
    };
    reader.readAsDataURL(file);
  }, []);

  // Paste is the natural gesture here — you have just taken a screenshot.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.items ?? [])]
        .find((i) => i.type.startsWith("image/"))
        ?.getAsFile();
      if (file) take(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [take]);

  async function read() {
    if (!payload) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/upload-sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, dryRun: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.detail ? `${json.error} — ${json.detail}` : json.error);
        return;
      }
      setResult(json);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-line bg-panel">
        <header className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold tracking-wide text-dim uppercase">
            Colmex screenshot
          </h2>
          <p className="mt-1 text-xs text-faint">
            Paste with Ctrl+V, or choose a file. Capture the header and the
            Positions panel — the Filled orders panel is ignored.
          </p>
        </header>

        <div className="space-y-4 p-4">
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) take(f);
            }}
            className="flex cursor-pointer items-center justify-center rounded-lg border border-dashed border-line bg-panel2 px-4 py-8 text-sm text-dim transition hover:border-faint hover:text-ink"
          >
            <input
              type="file"
              accept={MEDIA.join(",")}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) take(f);
              }}
            />
            {preview ? "Choose a different screenshot" : "Paste, drop, or click to choose a screenshot"}
          </label>

          {preview && (
            <img
              src={preview}
              alt="Colmex screenshot to be read"
              className="max-h-72 w-full rounded-lg border border-line object-contain"
            />
          )}

          {error && (
            <p className="rounded-lg border border-down/40 bg-down/5 px-3 py-2 text-sm text-down">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={read}
              disabled={!payload || busy}
              className="rounded-lg border border-acc/50 bg-acc/10 px-4 py-2 text-sm text-acc transition hover:bg-acc/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Reading…" : "Read the screenshot"}
            </button>
            <span className="text-xs text-faint">
              Nothing is written. Every row is checked against the
              platform&apos;s own arithmetic first.
            </span>
          </div>
        </div>
      </section>

      {result && <Verdict result={result} />}
    </div>
  );
}

function Verdict({ result }: { result: Result }) {
  const { verdict, account } = result;
  return (
    <section className="rounded-xl border border-line bg-panel">
      <header
        className={`border-b px-4 py-3 ${
          result.ok ? "border-up/40 bg-up/5" : "border-down/40 bg-down/5"
        }`}
      >
        <b className={result.ok ? "text-up" : "text-down"}>
          {result.ok
            ? `${verdict.verified} of ${verdict.positions} positions verified`
            : result.unreadable
              ? "The screenshot could not be read in full"
              : `${verdict.rejected} of ${verdict.positions} positions failed the check`}
        </b>{" "}
        <span className="text-dim">
          {result.ok
            ? "every row reproduces the platform's Net P/L and SL,value."
            : "nothing will be written until every row ties out."}
        </span>
        {result.notes && (
          <p className="mt-1 text-xs text-faint">{result.notes}</p>
        )}
      </header>

      <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-6 text-sm">
          <Field label="Account" value={account.label} />
          <Field label="Balance" value={`$${n(account.balance)}`} />
          <Field label="Projected" value={`$${n(account.equity)}`} />
        </div>

        {result.positions.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-line text-[11px] tracking-wider text-faint uppercase">
                  <th className="px-2 py-2 text-left">Symbol</th>
                  <th className="px-2 py-2 text-right">Qty</th>
                  <th className="px-2 py-2 text-right">Open</th>
                  <th className="px-2 py-2 text-right">Now</th>
                  <th className="px-2 py-2 text-right">Stop</th>
                  <th className="px-2 py-2 text-right">Net P/L</th>
                  <th className="px-2 py-2 text-right">Check</th>
                </tr>
              </thead>
              <tbody>
                {result.positions.map((p) => (
                  <tr key={`${p.symbol}:${p.side}`} className="border-b border-line/60">
                    <td className="px-2 py-2">
                      <b>{p.symbol}</b>{" "}
                      <span className="text-faint">{p.side}</span>
                    </td>
                    <td className="tnum px-2 py-2 text-right text-dim">{p.qty}</td>
                    <td className="tnum px-2 py-2 text-right">{n(p.openPrice, 4)}</td>
                    <td className="tnum px-2 py-2 text-right">{n(p.currentPrice)}</td>
                    <td className="tnum px-2 py-2 text-right text-dim">{n(p.slPrice)}</td>
                    <td
                      className={`tnum px-2 py-2 text-right ${p.netPl >= 0 ? "text-up" : "text-down"}`}
                    >
                      {n(p.netPl)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {p.check.ok ? (
                        <span className="text-up">ties out</span>
                      ) : (
                        <span className="text-down">rejected</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {verdict.problems.length > 0 && (
          <div className="rounded-lg border border-down/40 bg-down/5 px-3 py-2">
            <p className="mb-1 text-xs font-semibold tracking-wide text-down uppercase">
              Why the check failed
            </p>
            <ul className="space-y-1 text-xs text-dim">
              {verdict.problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-faint">
              Usually a cropped or blurred cell. Re-take the screenshot with the
              whole Positions panel visible and read it again.
            </p>
          </div>
        )}

        <p className="text-xs text-faint">
          Reading is all this does today — applying a verified read to the book
          is the next piece.
        </p>
      </div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] tracking-wider text-faint uppercase">{label}</div>
      <div className="tnum">{value}</div>
    </div>
  );
}
