// Server component (no "use client")
type CardBasics = {
  id: string;
  name?: string | null;
  number?: string | null;
  set_code?: string | null;
  set_name?: string | null;
};

type Props = {
  card: CardBasics;
  game: string;
  /** Visual style: "button" (default) or "pill" */
  variant?: "button" | "pill";
  /** Back-compat: when true, renders a smaller pill-style button */
  compact?: boolean;
  className?: string;
};

function labelForGame(game: string): string {
  const g = game.toLowerCase();
  if (g.includes("magic")) return "MTG";
  if (g.includes("yugioh") || g.includes("yu-gi")) return "Yu-Gi-Oh!";
  if (g.includes("pokemon")) return "Pokemon TCG";
  return game;
}

function buildQuery({ card, game }: { card: CardBasics; game: string }): string {
  const parts = [
    card.name ?? "",
    card.set_code ?? card.set_name ?? "",
    card.number ?? "",
    labelForGame(game),
  ]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  return parts.join(" ");
}

function classes(variant: Props["variant"], compact?: boolean, extra?: string): string {
  const v = compact ? "pill" : (variant ?? "button");
  const base =
    v === "pill"
      ? (compact
          ? "inline-flex items-center rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-medium text-white hover:bg-white/20"
          : "inline-flex items-center rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium text-white hover:bg-white/20")
      : "inline-flex items-center rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20";
  return extra ? `${base} ${extra}` : base;
}

export default function CardEbayCTA({ card, game, variant, compact, className }: Props) {
  const q = buildQuery({ card, game });
  const href = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={classes(variant, compact, className)}
      aria-label={`Search eBay for ${q}`}
    >
      eBay
    </a>
  );
}
