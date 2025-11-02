import "server-only";
import Link from "next/link";
import Image from "next/image";
import { CF_ACCOUNT_HASH } from "@/lib/cf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SetRow = { id: string; name: string | null; series: string | null; ptcgo_code?: string | null; release_date: string | null; logo_url: string | null; symbol_url: string | null; };
type ItemRow = { id: string; name: string | null; rarity: string | null; small_image: string | null; large_image: string | null; };
type SearchParams = Record<string, string | string[] | undefined>;

const CATEGORY = { label: "Magic: The Gathering", baseListHref: "/categories/mtg/sets", bannerCfId: "69ab5d2b-407c-4538-3c82-be8a551efa00" };
const PER_PAGE_OPTIONS = [30, 60, 120, 240] as const;
const cfImageUrl = (id: string, variant = "categoryThumb") => `https://imagedelivery.net/${CF_ACCOUNT_HASH}/${id}/${variant}`;
function parsePerPage(v?: string | string[]) { const s = Array.isArray(v) ? v[0] : v; const n = Number(s ?? 30); return (PER_PAGE_OPTIONS as readonly number[]).includes(n) ? n : 30; }
function parsePage(v?: string | string[]) { const s = Array.isArray(v) ? v[0] : v; const n = Number(s ?? 1); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1; }
function parseBool(v?: string | string[]) { const s = (Array.isArray(v) ? v[0] : v)?.toLowerCase(); return s === "1" || s === "true" || s === "on" || s === "yes"; }
function buildHref(base: string, qs: { q?: string | null; page?: number; perPage?: number; rares?: boolean; holo?: boolean }) { const p = new URLSearchParams(); if (qs.q) p.set("q", qs.q); if (qs.page) p.set("page", String(qs.page)); if (qs.perPage) p.set("perPage", String(qs.perPage)); if (qs.rares) p.set("rares","1"); if (qs.holo) p.set("holo","1"); const s = p.toString(); return s ? `${base}?${s}` : base; }
function bestImg(i: ItemRow){ return i.large_image || i.small_image || null; }

async function getSet(_id: string): Promise<SetRow | null> { return { id: _id, name: _id.replace(/-/g," "), series: null, ptcgo_code: null, release_date: null, logo_url: null, symbol_url: null }; }
async function getItems(_opts:{ setId:string; q:string|null; offset:number; limit:number; raresOnly:boolean; holoOnly:boolean; }):Promise<{rows:ItemRow[]; total:number;}> { return { rows: [], total: 0 }; }

export default async function MtgSetDetailPage({ params, searchParams }:{ params: Promise<{id:string}>; searchParams: Promise<SearchParams>; }) {
  const { id: rawId } = await params; const sp = await searchParams;
  const setParam = decodeURIComponent(rawId ?? "").trim();
  const baseHref = `${CATEGORY.baseListHref}/${encodeURIComponent(setParam)}`;
  const q = (Array.isArray(sp?.q) ? sp.q[0] : sp?.q)?.trim() || null;
  const perPage = parsePerPage(sp?.perPage);
  const reqPage = parsePage(sp?.page);
  const raresOnly = parseBool(sp?.rares);
  const holoOnly = parseBool(sp?.holo);

  const setRow = await getSet(setParam);
  const { rows, total } = await getItems({ setId: setParam, q, offset:(reqPage-1)*perPage, limit:perPage, raresOnly, holoOnly });

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(totalPages, reqPage);
  const offset = (page - 1) * perPage;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + perPage, total);

  const banner = setRow?.logo_url || setRow?.symbol_url || cfImageUrl(CATEGORY.bannerCfId);

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          <div className="relative h-20 w-36 shrink-0 rounded-lg bg-white/5 ring-1 ring-white/10 overflow-hidden">
            <Image src={banner} alt={setRow?.name ?? setParam} fill unoptimized className="object-contain" sizes="144px" priority />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">{CATEGORY.label}: {setRow?.name ?? setParam}</h1>
            <div className="text-sm text-white/80">Set browser & card index</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <Link href={CATEGORY.baseListHref} className="text-sky-300 hover:underline">← All {CATEGORY.label} sets</Link>
          <Link href="/categories" className="text-sky-300 hover:underline">← All categories</Link>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-white/80">Showing {from}-{to} of {total} cards{(q || raresOnly || holoOnly) ? " (filtered)" : ""}</div>
        <div className="flex flex-wrap gap-3">
          <form action={baseHref} method="get" className="flex items-center gap-2">
            {q ? <input type="hidden" name="q" value={q} /> : null}
            {raresOnly ? <input type="hidden" name="rares" value="1" /> : null}
            {holoOnly ? <input type="hidden" name="holo" value="1" /> : null}
            <input type="hidden" name="page" value="1" />
            <label htmlFor="pp" className="sr-only">Per page</label>
            <select id="pp" name="perPage" defaultValue={String(perPage)} className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-white">
              {PER_PAGE_OPTIONS.map((n) => (<option key={n} value={n}>{n}</option>))}
            </select>
            <button type="submit" className="rounded-md border border-white/20 bg-white/10 px-2.5 py-1 text-white hover:bg-white/20">Apply</button>
          </form>
          <form action={baseHref} method="get" className="flex items-center gap-2">
            {raresOnly ? <input type="hidden" name="rares" value="1" /> : null}
            {holoOnly ? <input type="hidden" name="holo" value="1" /> : null}
            <input type="hidden" name="perPage" value={String(perPage)} />
            <input type="hidden" name="page" value="1" />
            <input name="q" defaultValue={q ?? ""} placeholder="Search cards (name/rarity/id)…" className="w-[240px] md:w-[320px] rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-white/50" />
            <button type="submit" className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/20">Search</button>
            {q && <Link href={buildHref(baseHref, { perPage, page: 1, rares: raresOnly, holo: holoOnly })} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white hover:bg-white/15">Clear</Link>}
          </form>
          <form action={baseHref} method="get" className="flex items-center gap-3">
            {q ? <input type="hidden" name="q" value={q} /> : null}
            <input type="hidden" name="perPage" value={String(perPage)} />
            <input type="hidden" name="page" value="1" />
            <label className="inline-flex items-center gap-2 text-sm text-white/90"><input type="checkbox" name="rares" value="1" defaultChecked={parseBool(sp?.rares)} /> Rares+</label>
            <label className="inline-flex items-center gap-2 text-sm text-white/90"><input type="checkbox" name="holo" value="1" defaultChecked={parseBool(sp?.holo)} /> Holo only</label>
            <button type="submit" className="rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white hover:bg-white/20">Apply</button>
          </form>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-white/15 bg-white/5 p-6 text-white/90 backdrop-blur-sm">{q || parseBool(sp?.rares) || parseBool(sp?.holo) ? "No cards matched your filters." : "No cards found in this set yet."}</div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {rows.map((c) => {
            const img = bestImg(c);
            return (
              <li key={c.id} className="rounded-xl border border-white/10 bg-white/5 overflow-hidden backdrop-blur-sm hover:bg-white/10 hover:border-white/20 transition">
                <Link href={`/categories/mtg/cards/${encodeURIComponent(c.id)}`} className="block">
                  <div className="relative w-full" style={{ aspectRatio: "3 / 4" }}>
                    {img ? <Image src={img} alt={c.name ?? c.id} fill unoptimized className="object-contain" sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw" /> : <div className="absolute inset-0 grid place-items-center text-white/70">No image</div>}
                  </div>
                  <div className="p-3">
                    <div className="line-clamp-2 text-sm font-medium text-white">{c.name ?? c.id}</div>
                    <div className="mt-1 text-xs text-white/80">{c.rarity ?? ""}</div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
