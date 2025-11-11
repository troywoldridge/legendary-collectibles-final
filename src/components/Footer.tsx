import Link from "next/link";
import { site } from "@/config/site";

export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-16 border-t border-white/20 bg-neutral-950/90 text-white backdrop-blur-sm">
      <div className="mx-auto w-full max-w-7xl px-6 py-10 md:px-8">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {/* BRAND INFO */}
          <div>
            <h2 className="text-lg font-semibold text-white">{site.shortName}</h2>
            <p className="mt-3 text-sm text-neutral-400 leading-relaxed">
              {site.description ||
                "Your trusted shop for Pokémon, Yu-Gi-Oh!, MTG, and collectible gear."}
            </p>
            {site.email && (
              <p className="mt-4 text-sm text-neutral-400">
                📧 <a href={`mailto:${site.email}`} className="hover:text-white">
                  {site.email}
                </a>
              </p>
            )}
            {site.phone && (
              <p className="mt-2 text-sm text-neutral-400">
                📞 <a href={`tel:${site.phone}`} className="hover:text-white">
                  {site.phone}
                </a>
              </p>
            )}
          </div>

          {/* QUICK LINKS */}
          <div>
            <h3 className="text-lg font-semibold text-white">Shop</h3>
            <ul className="mt-4 space-y-2 text-sm text-neutral-400">
              <li><Link href="/categories/pokemon/sets" className="hover:text-white">Pokémon</Link></li>
              <li><Link href="/categories/yu-gi-oh" className="hover:text-white">Yu-Gi-Oh!</Link></li>
              <li><Link href="/categories/mtg" className="hover:text-white">Magic: The Gathering</Link></li>
              <li><Link href="/categories/funko" className="hover:text-white">Funko Pop</Link></li>
              <li><Link href="/search" className="hover:text-white">All Products</Link></li>
              {/* ★ Temporary Amazon link */}
              <li>
                <a
                  href="https://amzn.to/3JUSPsT"
                  target="_blank"
                  rel="nofollow sponsored noopener noreferrer"
                  className="hover:text-white"
                >
                  Amazon Deals
                </a>
              </li>
            </ul>
          </div>

          {/* INFO LINKS */}
          <div>
            <h3 className="text-lg font-semibold text-white">Info</h3>
            <ul className="mt-4 space-y-2 text-sm text-neutral-400">
              <li><Link href="/about" className="hover:text-white">About Us</Link></li>
              <li><Link href="/contact" className="hover:text-white">Contact</Link></li>
              <li><Link href="/faq" className="hover:text-white">FAQ</Link></li>
              <li><Link href="/shipping" className="hover:text-white">Shipping & Returns</Link></li>
              <li><Link href="/privacy" className="hover:text-white">Privacy Policy</Link></li>
            </ul>
          </div>

          {/* SOCIALS */}
          <div>
            <h3 className="text-lg font-semibold text-white">Follow Us</h3>
            <ul className="mt-4 flex gap-4 text-neutral-400">
              {site.socials?.instagram && (
                <li>
                  <a
                    href={site.socials.instagram}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Instagram"
                    className="hover:text-white"
                  >
                    <i className="ri-instagram-fill text-2xl" />
                  </a>
                </li>
              )}
              {site.socials?.facebook && (
                <li>
                  <a
                    href={site.socials.facebook}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Facebook"
                    className="hover:text-white"
                  >
                    <i className="ri-facebook-circle-fill text-2xl" />
                  </a>
                </li>
              )}
              {site.socials?.twitter && (
                <li>
                  <a
                    href={site.socials.twitter}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Twitter"
                    className="hover:text-white"
                  >
                    <i className="ri-twitter-x-fill text-2xl" />
                  </a>
                </li>
              )}
            </ul>
          </div>
        </div>

        {/* DISCLOSURES */}
        <div className="mt-8 space-y-1 text-xs text-neutral-400">
          <p>As an Amazon Associate I earn from qualifying purchases.</p>
          <p>As an eBay Partner, we may be compensated if you make a purchase.</p>
        </div>

        {/* BOTTOM ROW */}
        <div className="mt-8 flex flex-col items-center justify-between gap-4 border-t border-white/10 pt-6 text-sm text-neutral-400 sm:flex-row">
          <p>© {year} {site.name}. All rights reserved.</p>
          <p>
            Built with <span className="text-pink-400">❤</span> using{" "}
            <a href="https://nextjs.org" target="_blank" rel="noopener noreferrer" className="hover:text-white">
              Next.js
            </a>.
          </p>
        </div>
      </div>

      {/* SEO STRUCTURED DATA */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Organization",
            name: site.name,
            url: site.url,
            logo: `${site.url}/logo.png`,
            sameAs: Object.values(site.socials || {}).filter(Boolean),
            contactPoint: [
              {
                "@type": "ContactPoint",
                telephone: site.phone,
                contactType: "Customer Support",
                email: site.email,
                areaServed: "US",
                availableLanguage: ["English"],
              },
            ],
          }),
        }}
      />
    </footer>
  );
}
