import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { isAuthed } from "@/lib/auth";
import {
  colmexParse,
  checkRow,
  summarise,
  COLMEX_PROMPT,
  type ColmexParse,
} from "@/lib/colmex";

export const dynamic = "force-dynamic";
/** Vision plus thinking on a dense screenshot takes a while. */
export const maxDuration = 120;

const MEDIA = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

const body = z.object({
  /** Base64 image data, without the data: URI prefix. */
  image: z.string().min(100),
  mediaType: z.enum(MEDIA),
  /** Read the screen and report, but write nothing. The default — a sync
   *  should be something you look at before you accept it. */
  dryRun: z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  if (!(await isAuthed()))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!process.env.ANTHROPIC_API_KEY)
    return NextResponse.json(
      {
        error: "ANTHROPIC_API_KEY is not set",
        detail: "Add it in Vercel → Settings → Environment Variables.",
      },
      { status: 503 },
    );

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "validation failed", issues: parsed.error.issues },
      { status: 422 },
    );

  const { image, mediaType, dryRun } = parsed.data;

  let read: ColmexParse;
  try {
    const client = new Anthropic();
    const res = await client.messages.parse({
      model: "claude-opus-5",
      max_tokens: 16000,
      // The task is transcription, not reasoning. Medium keeps the latency
      // sane on a dense screenshot without skimping on the careful reading
      // a table of small digits actually needs.
      output_config: {
        effort: "medium",
        format: zodOutputFormat(colmexParse),
      },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: COLMEX_PROMPT },
          ],
        },
      ],
    });

    if (res.stop_reason === "refusal")
      return NextResponse.json(
        { error: "the model declined to read this image" },
        { status: 422 },
      );

    if (!res.parsed_output)
      return NextResponse.json(
        {
          error: "could not parse the screenshot",
          detail:
            res.stop_reason === "max_tokens"
              ? "ran out of output tokens — try cropping to the Positions panel"
              : `stopped with ${res.stop_reason}`,
        },
        { status: 422 },
      );

    read = res.parsed_output;
  } catch (e) {
    console.error("upload-sync: vision call failed", e);
    return NextResponse.json(
      { error: "vision call failed", detail: String(e).slice(0, 300) },
      { status: 502 },
    );
  }

  /**
   * The transcription is a claim, not a fact. Every row is re-derived from the
   * platform's own redundant columns before any of it is allowed near the
   * database — see src/lib/colmex.ts for why that works.
   */
  const checks = read.positions.map(checkRow);
  const verdict = summarise(read, checks);

  return NextResponse.json({
    ok: verdict.ok,
    dryRun,
    // Nothing is written yet. Applying the sync is the next step, and it is
    // deliberately not wired up in the same request as the parse: a number
    // read off an image should be looked at by a human once before it becomes
    // the book.
    applied: false,
    account: {
      label: read.accountLabel,
      balance: read.balance,
      equity: read.equity,
    },
    verdict,
    positions: read.positions.map((p, i) => ({
      ...p,
      check: checks[i],
    })),
    notes: read.notes || null,
    unreadable: read.unreadable,
  });
}
