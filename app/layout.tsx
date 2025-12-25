import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "start.gg Check-in Kiosk",
  description: "QR check-in kiosk and operator dashboard demo built with Next.js",
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
