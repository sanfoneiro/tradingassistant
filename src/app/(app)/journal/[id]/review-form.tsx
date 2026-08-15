"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const EXIT_REASONS = [
  "target_hit",
  "stop_hit",
  "time_stop",
  "thesis_broken",
  "discretionary",
  "trailed_out",
  "gapped",
] as const;

const EXECUTION = [
  "followed_plan",
  "deviated_entry",
  "deviated_exit",
  "exited_early",
  "exited_late",
  "no_exit_plan",
] as const;

const EMOTION = [
  "confident",
  "fomo",
  "hesitant",
  "revenge",
  "bored",
  "anxious",
] as const;

const pretty = (s: string) => s.replaceAll("_", " ");

export default function ReviewForm({
  tradeId,
  mistakes,
  applied,
  existing,
  exitReason,
  execution,
  emotion,
}: {
  tradeId: number;
  mistakes: { id: number; label: string; note: string }[];
  applied: number[];
  existing: {
    whatWorked: string;
    whatFailed: string;
    lesson: string;
    recurring: boolean;
    playbookEntry: string;
    playbookExit: string;
  } | null;
  exitReason: string | null;
  execution: string | null;
  emotion: string | null;
}) {
  const router = useRouter();
  const [exit, setExit] = useState(exitReason ?? "");
  const [exec, setExec] = useState(execution ?? "");
  const [mood, setMood] = useState(emotion ?? "");
  const [picked, setPicked] = useState<number[]>(applied);
  const [worked, setWorked] = useState(existing?.whatWorked ?? "");
  const [failed, setFailed] = useState(existing?.whatFailed ?? "");
  const [lesson, setLesson] = useState(existing?.lesson ?? "");
  const [recurring, setRecurring] = useState(existing?.recurring ?? false);
  const [pbIn, setPbIn] = useState(existing?.playbookEntry ?? "");
  const [pbOut, setPbOut] = useState(existing?.playbookExit ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = exit && exec && worked.trim() && failed.trim() && lesson.trim();

  async function save() {
    setSaving(true);
    setError(null);
    const res = await fetch("/api/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tradeId,
        exitReason: exit,
        execution: exec,
        emotion: mood || null,
        mistakeTagIds: picked,
        whatWorked: worked,
        whatFailed: failed,
        lesson,
        recurring,
        playbookEntry: pbIn || null,
        playbookExit: pbOut || null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setError((await res.json().catch(() => ({})))?.error ?? "save failed");
      return;
    }
    router.push("/journal");
    router.refresh();
  }

  return (
    <section className="rounded-xl border border-line bg-panel">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold tracking-wide text-dim uppercase">
          Review — six fields
        </h2>
        <p className="mt-1 text-xs text-faint">
          Under a minute. Everything else is either captured automatically or
          optional. The trade stays blocked until these are in.
        </p>
      </header>

      <div className="space-y-6 p-4">
        <Choice
          label="1 · Why did it end?"
          options={EXIT_REASONS as readonly string[]}
          value={exit}
          onChange={setExit}
        />
        <Choice
          label="2 · Execution"
          options={EXECUTION as readonly string[]}
          value={exec}
          onChange={setExec}
        />

        <div>
          <Label>3 · Mistakes — none is a valid answer</Label>
          <div className="flex flex-wrap gap-2">
            {mistakes.map((m) => {
              const on = picked.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  title={m.note}
                  onClick={() =>
                    setPicked((p) =>
                      on ? p.filter((x) => x !== m.id) : [...p, m.id],
                    )
                  }
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    on
                      ? "border-down/60 bg-down/10 text-down"
                      : "border-line text-dim hover:border-faint hover:text-ink"
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        <Text
          label="4 · What worked"
          value={worked}
          onChange={setWorked}
          placeholder="One line."
        />
        <Text
          label="5 · What failed"
          value={failed}
          onChange={setFailed}
          placeholder="One line."
        />
        <div>
          <Text
            label="6 · The lesson"
            value={lesson}
            onChange={setLesson}
            placeholder="One line. Specific enough to act on next time."
          />
          <label className="mt-2 flex items-center gap-2 text-xs text-dim">
            <input
              type="checkbox"
              checked={recurring}
              onChange={(e) => setRecurring(e.target.checked)}
              className="accent-[#e3b341]"
            />
            I have made this mistake before
            <span className="text-faint">
              — the third flag promotes it to a candidate rule
            </span>
          </label>
        </div>

        <details className="rounded-lg border border-line bg-panel2 px-3 py-2">
          <summary className="cursor-pointer text-xs text-dim">
            Optional — playbook and mood
          </summary>
          <div className="mt-3 space-y-4">
            <Text
              label="Entry playbook — exactly what the plan was"
              value={pbIn}
              onChange={setPbIn}
            />
            <Text
              label="Exit playbook"
              value={pbOut}
              onChange={setPbOut}
            />
            <Choice
              label="Mood at entry"
              options={EMOTION as readonly string[]}
              value={mood}
              onChange={setMood}
            />
          </div>
        </details>

        {error && <p className="text-sm text-down">{error}</p>}

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={!complete || saving}
            className="rounded-lg border border-acc/50 bg-acc/10 px-4 py-2 text-sm text-acc transition hover:bg-acc/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save review & close trade"}
          </button>
          {!complete && (
            <span className="text-xs text-faint">
              Fields 1, 2, 4, 5 and 6 are required.
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-xs font-semibold tracking-wide text-dim uppercase">
      {children}
    </div>
  );
}

function Choice({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => onChange(value === o ? "" : o)}
            className={`rounded-full border px-3 py-1 text-xs transition ${
              value === o
                ? "border-acc/60 bg-acc/10 text-acc"
                : "border-line text-dim hover:border-faint hover:text-ink"
            }`}
          >
            {pretty(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Text({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-line bg-panel2 px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-acc/60"
      />
    </div>
  );
}
