import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LAYRA 穿搭助手",
  description: "从你的衣柜出发，根据天气和场合给出每天都能穿的搭配。",
  openGraph: {
    title: "LAYRA 穿搭助手",
    description: "从自己的衣柜开始，找到今天真正会穿的一套。",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
