import UploadForm from "./upload-form";

export const dynamic = "force-dynamic";

export default function SyncPage() {
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-line bg-panel2 px-4 py-3 text-xs text-dim">
        <b className="text-ink">Reading a screenshot is not the same as knowing a number.</b>{" "}
        Which is why every row is re-derived from the platform&apos;s own
        redundant columns before it counts: Net P/L must equal
        (current − open) × qty − fee, and SL,value must equal
        |open − stop| × qty. A row that does not reproduce both is rejected
        rather than ingested — a misread digit breaks at least one of them.
      </div>
      <UploadForm />
    </div>
  );
}
