import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AttendeesWebApp",
  description: "QR check-in and operator dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
