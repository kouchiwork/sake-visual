import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SakeLens",
  description: "日本酒ボトルをスタジオ撮影風に自動変換",
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
