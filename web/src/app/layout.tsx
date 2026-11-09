import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: { default: "Blink Node · 服务器控制台", template: "%s · Blink Node" },
  description: "私有服务器监控与运维控制台",
  robots: { index: false, follow: false },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
