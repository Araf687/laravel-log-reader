import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Laravel Log Reader",
  description: "Inspect Laravel log files with searchable stack traces, level filters, and local-first parsing.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
