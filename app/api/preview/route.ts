import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// This endpoint receives modified HTML via form POST and serves it
// back as text/html. The iframe loads from our domain (proper origin),
// so all CSS/JS can execute correctly.
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const html = formData.get("html");

    if (!html || typeof html !== "string") {
      return NextResponse.json({ error: "Missing html field" }, { status: 400 });
    }

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Frame-Options": "SAMEORIGIN",
      },
    });
  } catch {
    return new Response("<h1>Preview Error</h1>", {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}
