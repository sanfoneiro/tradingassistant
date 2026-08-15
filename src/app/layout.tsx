import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TradingAssistant",
  description: "Account, journal, and rules — one source of truth.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
