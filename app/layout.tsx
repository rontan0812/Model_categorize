import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Model Categorize",
  description: "フォルダ内の3Dモデルにラベルを付けて分類するアプリ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
