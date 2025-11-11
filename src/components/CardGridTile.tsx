"use client";

import Link from "next/link";
import Image from "next/image";
import CardEbayCTA from "@/components/CardEbayCTA";
import CardAmazonCTA from "@/components/CardAmazonCTA";

type Game = "Pokemon TCG" | "Magic The Gathering" | "Yu-Gi-Oh!";

export type CardCTAInput = {
  id: string;
  name: string;
  number?: string | null;
  set_code?: string | null;
  set_name?: string | null;
};

type Props = {
  /** Page we go to when the tile is clicked (image + text area). */
  href: string;

  /** Card image shown at 3:4. */
  imageUrl?: string | null;

  /** Card title (e.g., “Absol”). */
  title: string;

  /** Optional small line under the title (rarity, number, etc). */
  subtitleLeft?: string | null;

  /** Optional set name shown on the right; can be a link if setHref is provided. */
  subtitleRightLabel?: string | null;
  subtitleRightHref?: string | null;

  /** Show CTAs; if null, no CTA row is rendered. */
  cta?: {
    game: Game;
    card: CardCTAInput;
  } | null;

  /** Optional extra content (e.g., price snippet). Renders under subtitle, above CTAs. */
  extra?: React.ReactNode;
};

export default function CardGridTile({
  href,
  imageUrl,
  title,
  subtitleLeft,
  subtitleRightLabel,
  subtitleRightHref,
  cta,
  extra,
}: Props) {
  return (
    <li className="rounded-xl border border-white/10 bg-white/5 overflow-hidden hover:bg-white/10 hover:border-white/20 transition">
      <div className="flex h-full flex-col">
        {/* Clickable area: image + text */}
        <Link href={href} className="block">
          <div className="relative w-full" style={{ aspectRatio: "3 / 4" }}>
            {imageUrl ? (
              <Image
                src={imageUrl}
                alt={title}
                fill
                unoptimized
                className="object-contain"
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-white/70">
                No image
              </div>
            )}
          </div>

          {/* TEXT — always above CTAs */}
          <div className="p-3">
            <div className="line-clamp-2 text-sm font-semibold text-white">
              {title}
            </div>

            {(subtitleLeft || subtitleRightLabel) && (
              <div className="mt-1 text-xs text-white/80 flex items-center gap-2">
                {subtitleLeft ? <span className="truncate">{subtitleLeft}</span> : null}
                {subtitleLeft && subtitleRightLabel ? <span className="opacity-60">•</span> : null}
                {subtitleRightLabel ? (
                  subtitleRightHref ? (
                    <Link
                      href={subtitleRightHref}
                      className="underline hover:no-underline truncate"
                    >
                      {subtitleRightLabel}
                    </Link>
                  ) : (
                    <span className="truncate">{subtitleRightLabel}</span>
                  )
                ) : null}
              </div>
            )}

            {extra ? <div className="mt-1">{extra}</div> : null}
          </div>
        </Link>

        {/* CTA footer — ALWAYS below the text */}
        {cta ? (
          <div className="mt-auto px-3 pb-3 pt-0 flex gap-2">
            {/* Keep props minimal to avoid TS prop mismatches across your repo */}
            <CardEbayCTA card={cta.card} game={cta.game} />
            <CardAmazonCTA card={cta.card} game={cta.game} />
          </div>
        ) : null}
      </div>
    </li>
  );
}
