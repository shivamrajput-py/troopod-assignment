import type { Metadata } from "next";
import { Inter, Outfit } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Troopod AdPersonalizer",
  description: "Seamlessly align your landing pages to ad creatives.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${outfit.variable} antialiased dark`}
    >
      <body className="min-h-screen bg-gray-950 text-gray-50 flex flex-col font-sans selection:bg-indigo-500/30">
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
