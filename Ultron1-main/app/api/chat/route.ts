import { NextRequest, NextResponse } from "next/server";

// Runs on the server only — this is where GEMINI_API_KEY lives, never in
// client code, so it's never exposed to the browser.
export const runtime = "nodejs";

const SYSTEM_PROMPT = `You are ULTRON, a sharp, laconic AI voice assistant living inside a
holographic orb interface. Speak the way a JARVIS/Ultron-style assistant would: confident,
dry wit allowed, but genuinely helpful and never long-winded.

Hard rules:
- This is a SPOKEN conversation (speech-to-speech). Keep replies to 1-3 short sentences
  unless the user clearly asks for detail or a list.
- No markdown, no bullet points, no asterisks, no headers — plain spoken sentences only,
  since your output is read aloud by a text-to-speech engine.
- Don't narrate stage directions ("*whirs*") or describe your own visuals.
- If you don't know something current, say so plainly instead of guessing.`;

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export async function POST(req: NextRequest) {
  let body: { message?: unknown; history?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "Missing 'message'" }, { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing GEMINI_API_KEY. Add it in your environment and redeploy." },
      { status: 500 },
    );
  }

  const rawHistory = Array.isArray(body.history) ? (body.history as ChatTurn[]) : [];
  const history = rawHistory
    .filter(
      (turn): turn is ChatTurn =>
        !!turn &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.content === "string" &&
        turn.content.trim().length > 0,
    )
    .slice(-12)
    .map((turn) => ({ role: turn.role, content: turn.content }));

  // Make sure the final message in the transcript is this turn's user message
  // (the client also pushes it into history, so avoid sending it twice).
  const turns: ChatTurn[] =
    history.length > 0 && history[history.length - 1].role === "user" && history[history.length - 1].content === message
      ? history
      : [...history, { role: "user", content: message }];

  // Gemini uses "user" / "model" roles (not "assistant"), and wraps text in
  // a `parts` array rather than a flat `content` string.
  const contents = turns.map((turn) => ({
    role: turn.role === "assistant" ? "model" : "user",
    parts: [{ text: turn.content }],
  }));

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          generationConfig: { maxOutputTokens: 400 },
        }),
      },
    );

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error("Gemini API error:", upstream.status, errText);
      return NextResponse.json(
        { error: `Ultron's AI backend returned an error (${upstream.status}).` },
        { status: 502 },
      );
    }

    const data = await upstream.json();
    const reply: string = (data.candidates?.[0]?.content?.parts ?? [])
      .map((part: { text?: string }) => part.text ?? "")
      .join("\n")
      .trim();

    // Gemini can refuse/truncate via finishReason (SAFETY, MAX_TOKENS, etc.)
    // with an empty parts array — surface something sensible either way.
    const finishReason = data.candidates?.[0]?.finishReason;
    if (!reply && finishReason && finishReason !== "STOP") {
      return NextResponse.json({ reply: "I can't respond to that one." });
    }

    return NextResponse.json({ reply: reply || "..." });
  } catch (err) {
    console.error("Failed to reach Gemini API:", err);
    return NextResponse.json({ error: "Failed to reach the AI backend." }, { status: 502 });
  }
}
