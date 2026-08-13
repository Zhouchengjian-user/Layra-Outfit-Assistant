import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "搭搭 · AI 穿搭助手",
  description: "读懂天气、场合和你的个人衣柜，每天搭出刚刚好的样子。",
  openGraph: {
    title: "搭搭 · AI 穿搭助手",
    description: "每天穿什么，交给你的衣柜。",
    images: [{ url: "/og.png", width: 1734, height: 907 }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
