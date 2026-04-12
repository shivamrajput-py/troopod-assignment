import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Troopod AdPersonalizer",
  description: "Seamlessly align your landing pages to ad creatives using AI.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="antialiased dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-gray-950 text-gray-50 flex flex-col font-sans selection:bg-indigo-500/30">
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
