// src/lib/db/schema.ts
// Drizzle schema for all tables you listed from the Neon DB export.
// Adjust types where necessary (this is intentionally conservative — text for custom/enums).

import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  numeric,
  uuid,
  bigserial
} from "drizzle-orm/pg-core";

/**
 * E-commerce tables
 */

// cart_lines
export const cart_lines = pgTable("cart_lines", {
  id: serial("id").primaryKey(),
  cart_id: uuid("cart_id").notNull(),
  product_id: integer("product_id").notNull(),
  qty: integer("qty").notNull(),
  created_at: timestamp("created_at"),
  updated_at: timestamp("updated_at"),
});

// carts
export const carts = pgTable("carts", {
  id: uuid("id").primaryKey(),
  status: text("status"),
  created_at: timestamp("created_at"),
  updated_at: timestamp("updated_at"),
});

// categories
export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  slug: text("slug"),
  name: text("name"),
  description: text("description"),
  cf_image_id: text("cf_image_id"),
  cf_alt: text("cf_alt"),
  sort_order: integer("sort_order"),
  created_at: timestamp("created_at"),
  updated_at: timestamp("updated_at"),
});

// images
export const images = pgTable("images", {
  id: serial("id").primaryKey(),
  // owner_type and variant were USER-DEFINED in PG; store as text here
  owner_type: text("owner_type"),
  owner_id: integer("owner_id"),
  variant: text("variant"),
  cf_image_id: text("cf_image_id"),
  url: text("url"),
  alt: text("alt"),
  sort_order: integer("sort_order"),
  created_at: timestamp("created_at"),
  updated_at: timestamp("updated_at"),
});

// orders
export const orders = pgTable("orders", {
  id: uuid("id").primaryKey(),
  cart_id: uuid("cart_id"),
  stripe_payment_intent_id: text("stripe_payment_intent_id"),
  amount_cents: integer("amount_cents"),
  currency: text("currency"),
  status: text("status"),
  created_at: timestamp("created_at"),
  updated_at: timestamp("updated_at"),
});

// products
export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  subcategory_id: integer("subcategory_id"),
  sku: text("sku"),
  name: text("name"),
  description: text("description"),
  image_url: text("image_url"),
  cf_image_id: text("cf_image_id"),
  cf_alt: text("cf_alt"),
  price_cents: integer("price_cents"),
  msrp_cents: integer("msrp_cents"),
  inventory: integer("inventory"),
  in_stock: boolean("in_stock"),
  sort_order: integer("sort_order"),
  created_at: timestamp("created_at"),
  updated_at: timestamp("updated_at"),
});

// subcategories
export const subcategories = pgTable("subcategories", {
  id: serial("id").primaryKey(),
  category_id: integer("category_id"),
  slug: text("slug"),
  name: text("name"),
  description: text("description"),
  cf_image_id: text("cf_image_id"),
  cf_alt: text("cf_alt"),
  sort_order: integer("sort_order"),
  created_at: timestamp("created_at"),
  updated_at: timestamp("updated_at"),
});

/**
 * TCG-specific tables (Pokemon/TCG data)
 * These files were mostly `text` typed in the DB export — keep as text.
 */

// tcg_card_abilities
export const tcg_card_abilities = pgTable("tcg_card_abilities", {
  card_id: text("card_id").notNull(),
  name: text("name"),
  text: text("text"),
  type: text("type"),
  slot: text("slot"),
});

// tcg_card_attacks
export const tcg_card_attacks = pgTable("tcg_card_attacks", {
  card_id: text("card_id").notNull(),
  slot: text("slot"),
  name: text("name"),
  text: text("text"),
  damage: text("damage"),
  converted_energy_cost: text("converted_energy_cost"),
  cost: text("cost"),
});

// tcg_card_images
export const tcg_card_images = pgTable("tcg_card_images", {
  card_id: text("card_id").notNull(),
  small: text("small"),
  large: text("large"),
  source: text("source"),
});

// tcg_card_legalities
export const tcg_card_legalities = pgTable("tcg_card_legalities", {
  card_id: text("card_id").notNull(),
  format: text("format"),
  legality: text("legality"),
});

// tcg_card_prices_cardmarket
export const tcg_card_prices_cardmarket = pgTable(
  "tcg_card_prices_cardmarket",
  {
    card_id: text("card_id").notNull(),
    url: text("url"),
    updated_at: text("updated_at"),
    average_sell_price: text("average_sell_price"),
    low_price: text("low_price"),
    trend_price: text("trend_price"),
    german_pro_low: text("german_pro_low"),
    suggested_price: text("suggested_price"),
    reverse_holo_sell: text("reverse_holo_sell"),
    reverse_holo_low: text("reverse_holo_low"),
    reverse_holo_trend: text("reverse_holo_trend"),
    low_price_ex_plus: text("low_price_ex_plus"),
    avg1: text("avg1"),
    avg7: text("avg7"),
    avg30: text("avg30"),
    reverse_holo_avg1: text("reverse_holo_avg1"),
    reverse_holo_avg7: text("reverse_holo_avg7"),
    reverse_holo_avg30: text("reverse_holo_avg30"),
  }
);

// tcg_card_prices_tcgplayer
export const tcg_card_prices_tcgplayer = pgTable(
  "tcg_card_prices_tcgplayer",
  {
    card_id: text("card_id").notNull(),
    url: text("url"),
    updated_at: text("updated_at"),
    normal: text("normal"),
    holofoil: text("holofoil"),
    reverse_holofoil: text("reverse_holofoil"),
    first_edition_holofoil: text("first_edition_holofoil"),
    first_edition_normal: text("first_edition_normal"),
    currency: text("currency"),
  }
);

// tcg_card_resistances
export const tcg_card_resistances = pgTable("tcg_card_resistances", {
  card_id: text("card_id").notNull(),
  type: text("type"),
  value: text("value"),
  slot: text("slot"),
});

// tcg_card_weaknesses
export const tcg_card_weaknesses = pgTable("tcg_card_weaknesses", {
  card_id: text("card_id").notNull(),
  type: text("type"),
  value: text("value"),
  slot: text("slot"),
});

// tcg_cards
export const tcg_cards = pgTable("tcg_cards", {
  id: text("id").primaryKey(), // original exported as text IDs
  name: text("name"),
  supertype: text("supertype"),
  subtypes: text("subtypes"),
  level: text("level"),
  hp: text("hp"),
  types: text("types"),
  evolves_from: text("evolves_from"),
  evolves_to: text("evolves_to"),
  rules: text("rules"),
  ancient_trait_name: text("ancient_trait_name"),
  ancient_trait_text: text("ancient_trait_text"),
  converted_retreat_cost: text("converted_retreat_cost"),
  retreat_cost: text("retreat_cost"),
  set_id: text("set_id"),
  set_name: text("set_name"),
  series: text("series"),
  printed_total: text("printed_total"),
  total: text("total"),
  ptcgo_code: text("ptcgo_code"),
  release_date: text("release_date"),
  set_updated_at: text("set_updated_at"),
  symbol_url: text("symbol_url"),
  logo_url: text("logo_url"),
  regulation_mark: text("regulation_mark"),
  artist: text("artist"),
  rarity: text("rarity"),
  flavor_text: text("flavor_text"),
  national_pokedex_numbers: text("national_pokedex_numbers"),
  extra: text("extra"),
  small_image: text("small_image"),
  large_image: text("large_image"),
  tcgplayer_url: text("tcgplayer_url"),
  tcgplayer_updated_at: text("tcgplayer_updated_at"),
  cardmarket_url: text("cardmarket_url"),
  cardmarket_updated_at: text("cardmarket_updated_at"),
});

// tcg_rarities
export const tcg_rarities = pgTable("tcg_rarities", {
  name: text("name"),
});

// tcg_sets
export const tcg_sets = pgTable("tcg_sets", {
  id: text("id").primaryKey(),
  name: text("name"),
  series: text("series"),
  printed_total: text("printed_total"),
  total: text("total"),
  ptcgo_code: text("ptcgo_code"),
  release_date: text("release_date"),
  updated_at: text("updated_at"),
  symbol_url: text("symbol_url"),
  logo_url: text("logo_url"),
  standard: text("standard"),
  expanded: text("expanded"),
  unlimited: text("unlimited"),
});

// tcg_sets_legalities
export const tcg_sets_legalities = pgTable("tcg_sets_legalities", {
  set_id: text("set_id"),
  format: text("format"),
  legality: text("legality"),
});

// tcg_subtypes
export const tcg_subtypes = pgTable("tcg_subtypes", {
  name: text("name"),
});

// tcg_supertypes
export const tcg_supertypes = pgTable("tcg_supertypes", {
  name: text("name"),
});

// tcg_types
export const tcg_types = pgTable("tcg_types", {
  name: text("name"),
});




export const tcgCardPricesTcgplayerHistory = pgTable("tcg_card_prices_tcgplayer_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  cardId: text("card_id").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
  currency: text("currency"),
  normal: numeric("normal", { precision: 12, scale: 2 }),
  holofoil: numeric("holofoil", { precision: 12, scale: 2 }),
  reverseHolofoil: numeric("reverse_holofoil", { precision: 12, scale: 2 }),
  firstEditionHolofoil: numeric("first_edition_holofoil", { precision: 12, scale: 2 }),
  firstEditionNormal: numeric("first_edition_normal", { precision: 12, scale: 2 }),
});

export const tcgCardPricesCardmarketHistory = pgTable("tcg_card_prices_cardmarket_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  cardId: text("card_id").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
  averageSellPrice: numeric("average_sell_price", { precision: 12, scale: 2 }),
  lowPrice: numeric("low_price", { precision: 12, scale: 2 }),
  trendPrice: numeric("trend_price", { precision: 12, scale: 2 }),
  germanProLow: numeric("german_pro_low", { precision: 12, scale: 2 }),
  suggestedPrice: numeric("suggested_price", { precision: 12, scale: 2 }),
  reverseHoloSell: numeric("reverse_holo_sell", { precision: 12, scale: 2 }),
  reverseHoloLow: numeric("reverse_holo_low", { precision: 12, scale: 2 }),
  reverseHoloTrend: numeric("reverse_holo_trend", { precision: 12, scale: 2 }),
  lowPriceExPlus: numeric("low_price_ex_plus", { precision: 12, scale: 2 }),
  avg1: numeric("avg1", { precision: 12, scale: 2 }),
  avg7: numeric("avg7", { precision: 12, scale: 2 }),
  avg30: numeric("avg30", { precision: 12, scale: 2 }),
  reverseHoloAvg1: numeric("reverse_holo_avg1", { precision: 12, scale: 2 }),
  reverseHoloAvg7: numeric("reverse_holo_avg7", { precision: 12, scale: 2 }),
  reverseHoloAvg30: numeric("reverse_holo_avg30", { precision: 12, scale: 2 }),
});

export const ygoCardPricesHistory = pgTable("ygo_card_prices_history", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  cardId: text("card_id").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
  tcgplayerPrice: numeric("tcgplayer_price", { precision: 12, scale: 2 }),
  cardmarketPrice: numeric("cardmarket_price", { precision: 12, scale: 2 }),
  ebayPrice: numeric("ebay_price", { precision: 12, scale: 2 }),
  amazonPrice: numeric("amazon_price", { precision: 12, scale: 2 }),
  coolstuffincPrice: numeric("coolstuffinc_price", { precision: 12, scale: 2 }),
});
