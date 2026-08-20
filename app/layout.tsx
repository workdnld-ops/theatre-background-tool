import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "劇場投影背景模擬器",
  description: "在舞台比例中預覽、調整與比較多張投影背景。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
