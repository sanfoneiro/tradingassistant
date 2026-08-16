import Link from "next/link";
import { redirect } from "next/navigation";
import { isAuthed } from "@/lib/auth";

const NAV = [
  { href: "/", label: "Account" },
  { href: "/ideas", label: "Ideas" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/journal", label: "Journal" },
  { href: "/reports", label: "Reports" },
  { href: "/rules", label: "Rules" },
];

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await isAuthed())) redirect("/login");

  return (
    <>
      <nav className="border-b border-line bg-panel/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-1 px-4 py-3">
          <span className="mr-4 font-mono text-sm text-faint">
            trading<span className="text-acc">assistant</span>
          </span>
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className="rounded-md px-3 py-1.5 text-sm text-dim transition hover:bg-panel2 hover:text-ink"
            >
              {n.label}
            </Link>
          ))}
        </div>
      </nav>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </>
  );
}
