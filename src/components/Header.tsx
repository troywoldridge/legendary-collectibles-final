"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { site } from "@/config/site";
import { cfUrl, CF_ACCOUNT_HASH, type Variant } from "@/lib/cf";

const LOGO_CF_ID =
  process.env.NEXT_PUBLIC_CF_LOGO_ID || "f7b75c90-dccb-4c37-e603-2bc749caaa00";

const LOGO_VARIANTS: Variant[] = ["hero", "public", "category", "card", "productThumb"];

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus search with "/"
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField =
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement;
      if (e.key === "/" && !inField) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const isActive = (href: string) =>
    pathname === href || (href !== "/" && pathname.startsWith(href));

  // Cloudflare Image URL fallbacks for the logo
  const logoCandidates = useMemo(() => {
    const list = LOGO_VARIANTS.map((v) => cfUrl(LOGO_CF_ID, v)).filter(Boolean) as string[];
    if (CF_ACCOUNT_HASH) {
      list.push(`https://imagedelivery.net/${CF_ACCOUNT_HASH}/${LOGO_CF_ID}/public`);
    }
    return list;
  }, []);
  const [logoIdx, setLogoIdx] = useState(0);
  const logoSrc = logoCandidates[logoIdx];

  // Explicit nav order (condensed labels)
  const nav = [
    { href: "/", label: "Home" },
    { href: "/categories/pokemon/sets", label: "Pokémon Sets" },
    { href: "/categories/pokemon/cards", label: "Pokémon Cards" },
    { href: "/categories/yugioh/sets", label: "Yu-Gi-Oh! Sets" },   // non-breaking hyphens
    { href: "/categories/yugioh/cards", label: "Yu-Gi-Oh! Cards" }, // non-breaking hyphens
    { href: "/categories/magic/sets", label: "MTG Sets" },
    { href: "/categories/magic/cards", label: "MTG Cards" },
    { href: "/categories/sports-cards", label: "Sports Cards" },
    { href: "/categories/funko-pop", label: "Funko Pop" },
  ] as const;

  return (
    <header className="sticky top-0 z-50 bg-transparent">
      {/* full-width bar */}
      <div className="w-full px-4 sm:px-6 lg:px-8">
        <div className="flex w-full items-center justify-between gap-3 py-2">
          {/* Logo */}
          <div className="shrink-0">
            <Link href="/" aria-label={`${site.shortName} Home`} className="flex items-center">
              {logoSrc ? (
                <Image
                  src={logoSrc}
                  alt={`${site.shortName} logo`}
                  width={220}
                  height={88}
                  unoptimized
                  priority
                  className="h-12 w-auto object-contain sm:h-14 md:h-16"
                  onError={() =>
                    setLogoIdx((i) => (i + 1 < logoCandidates.length ? i + 1 : i))
                  }
                />
              ) : (
                <div className="h-12 w-12 rounded bg-sky-500" />
              )}
            </Link>
          </div>

          {/* Nav: no-wrap, can scroll horizontally if needed; slightly smaller text */}
          <nav className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap no-scrollbar">
            <div className="flex items-center gap-5 md:gap-6 text-[15px] md:text-[16px]">
              {nav.map((n) => {
                const active = isActive(n.href);
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    aria-current={active ? "page" : undefined}
                    className={`transition-colors ${
                      active
                        ? "text-white font-semibold underline underline-offset-4"
                        : "text-white/85 hover:text-white"
                    }`}
                  >
                    {n.label}
                  </Link>
                );
              })}
            </div>
          </nav>

          {/* Compact search (smaller width) */}
          <div className="ml-2 flex items-center">
            <form
              className="hidden md:flex items-center overflow-hidden rounded-2xl bg-white/10 backdrop-blur-xl px-2 py-1"
              onSubmit={(e) => {
                e.preventDefault();
                const query = q.trim();
                if (query) router.push(`/categories/pokemon/cards?q=${encodeURIComponent(query)}&page=1`);
              }}
            >
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder='Search… ("/")'
                className="w-[240px] lg:w-[300px] xl:w-[320px] bg-transparent border-0 outline-none px-3 py-1.5 text-sm text-white placeholder:text-white/70"
              />
              <button
                type="submit"
                className="rounded-xl bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20"
              >
                Search
              </button>
            </form>

            {/* Mobile shortcut */}
            <Link
              href="/categories/pokemon/cards"
              className="md:hidden inline-flex items-center gap-1 rounded-2xl bg-white/10 px-3 py-2 text-sm font-medium text-white backdrop-blur-xl hover:bg-white/20"
            >
              🔍 Search
            </Link>
          </div>
        </div>
      </div>

      {/* tiny helper to hide scrollbars on nav (optional) */}
      <style jsx global>{`
        .no-scrollbar::-webkit-scrollbar {
          display: none;
        }
        .no-scrollbar {
          -ms-overflow-style: none; /* IE/Edge */
          scrollbar-width: none; /* Firefox */
        }
      `}</style>
    </header>
  );
}
