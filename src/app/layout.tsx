import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Creature World",
  description: "A small town of autonomous creatures with drives, feelings and a diary.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
