import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CKB Session Kit",
  description: "Browser-held self-custody sessions for CKB applications — live testnet demo",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
