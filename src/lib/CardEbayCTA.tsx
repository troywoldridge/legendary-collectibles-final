"use client";

import { ebaySearchLink } from "@/lib/ebay";

type CardLike = {
  id: string;
  name?: string | null;
  number?: string | null;
  collector_number?: string | null;
  set_code?: string | null;
  set_name?: string | null;
};

type Props = {
  card: CardLike;
  game: "Pokemon" | "Yu-Gi-Oh!" | "Magic The Gathering" | string;
  className?: string;
  label?: string;
  compact?: boolean;
};

export default function CardEbayCTA({
  card,
  game,
  className,
  label,
  compact = false,
}: Props) {
  const num = card.number ?? card.collector_number ?? null;
  const set = card.set_code ?? card.set_name ?? null;

  const q = [card.name, set, num, game, "card"].filter(Boolean).join(" ");
  const href = ebaySearchLink({ q });

  const base =
    "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium hover:opacity-90";
  const compactClasses = compact ? "px-2 py-1 text-[11px]" : "";
  const classes = [base, compactClasses, className].filter(Boolean).join(" ");

  return (
    <a
      href={href}
      target="_blank"
      rel="nofollow sponsored noopener"
      className={classes}
      aria-label={`Search eBay for ${q}`}
      title={`Search eBay for ${q}`}
    >
      <span aria-hidden>🧾</span>
      <span>{label ?? "See on eBay"}</span>
    </a>
  );
}
