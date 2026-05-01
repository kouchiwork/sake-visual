import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "背景を黒くするアプリ",
  description: "画像の背景を黒に変換するアプリ",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body className="bg-gray-950 text-white min-h-screen">{children}</body>
    </html>
  );
}
