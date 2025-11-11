"use client";

import { amazonSearchLink } from "@/lib/amazon";
import clsx from "clsx";

type AmazonButtonProps = {
  name?: string | null;
  setCode?: string | null;
  number?: string | null;
  game?: "Pokemon" | "Yu-Gi-Oh!" | "Magic The Gathering" | string;
  tag?: string;           // defaults to NEXT_PUBLIC_AMAZON_ASSOCIATE_TAG
  className?: string;
  children?: React.ReactNode;
};

export default function AmazonButton({
  name,
  setCode,
  number,
  game = "Pokemon",
  tag = process.env.NEXT_PUBLIC_AMAZON_ASSOCIATE_TAG,
  className,
  children,
}: AmazonButtonProps) {
  const q = [name, setCode, number, game, "card"].filter(Boolean).join(" ");
  const href = amazonSearchLink({ q, tag });

  return (
    <a
      href={href}
      target="_blank"
      rel="nofollow sponsored noopener"
      className={clsx(
        "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:opacity-90",
        className
      )}
      aria-label={`Search Amazon for ${q}`}
    >
      {children ?? "Buy on Amazon"}
    </a>
  );
}

