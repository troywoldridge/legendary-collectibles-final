// Build Amazon affiliate links without PA-API (pre-approval safe)

export function amazonSearchLink(opts: { q: string; tag?: string }) {
  const { q, tag } = opts;
  const url = new URL("https://www.amazon.com/s");
  url.searchParams.set("k", q);
  if (tag) url.searchParams.set("tag", tag);
  url.searchParams.set("language", "en_US");
  return url.toString();
}

export function amazonDpLink(opts: { asin: string; tag?: string }) {
  const { asin, tag } = opts;
  const url = new URL(`https://www.amazon.com/dp/${asin}`);
  if (tag) url.searchParams.set("tag", tag);
  url.searchParams.set("language", "en_US");
  return url.toString();
}
