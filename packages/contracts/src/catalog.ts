// Catalog (P3.1): search, standard prices, items, duplicate guard, vehicle
// models. Selling prices only.
//
//   GET  /api/catalog/search?q&jobId          CatalogSearchResult
//   POST /api/catalog/prices                  CatalogPriceCreateInput  -> CatalogPriceWritten
//   PUT  /api/catalog/prices/:id              CatalogPriceFixInput     -> CatalogPriceWritten
//   POST /api/catalog/items                   CatalogItemCreateInput   -> CatalogItem
//   GET  /api/catalog/similar?category&name   CatalogSimilarResult
//   POST /api/catalog/items/:id/merge         CatalogMergeInput        -> CatalogMergeResult
//   GET  /api/warranty-terms                  WarrantyTermList
//   GET  /api/vehicle-models?q                VehicleModelPage
//   POST /api/vehicle-models                  VehicleModelCreateInput  -> VehicleModel
//   PUT  /api/vehicles/:id/model              VehicleModelAssignInput  -> VehicleModelAssigned
//   GET  /api/vehicle-models/unmatched        UnmatchedModelPage
//   POST /api/vehicle-models/unmatched/assign UnmatchedAssignInput   -> UnmatchedAssignResult
//
// NO COST ANYWHERE. products.price is the shop's cost and never reaches this
// package: every object below is .strict(), so a cost or margin field added on
// the server without a schema change is a parse failure on the client and in
// the tier-2 tests (CLAUDE.md §12.2 — an advisor must never receive cost).
//
// Wire money is a decimal string ("1234.50"), never a float; quantity likewise.

import { z } from 'zod';
import { DECLINE_REASONS } from '@champpower/domain';
import { PageQuery, uuid } from './common.js';

/** numeric(12,2), >= 0, at most 2 decimals. */
export const MoneyString = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'invalid_money');
export type MoneyString = z.infer<typeof MoneyString>;

/** A quantity: positive, at most 2 decimals. */
export const QtyString = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'invalid_qty')
  .refine((v) => Number(v) > 0, 'invalid_qty');
export type QtyString = z.infer<typeof QtyString>;

export const LineType = z.enum(['part', 'labor', 'fee']);
export type LineType = z.infer<typeof LineType>;

export const DeclineReason = z.enum(DECLINE_REASONS);
export type DeclineReason = z.infer<typeof DeclineReason>;

export const PriceSource = z.enum(['model', 'base', 'manual']);
export type PriceSource = z.infer<typeof PriceSource>;

/** Free-text reason attached to a money change. */
export const ChangeReason = z.string().trim().min(1).max(500);

// Matches migration 0010's warranty_terms (days / max_km, not months) — the
// per-sold-item warranty table this catalog reuses, not a new concept.
export const WarrantyTermOption = z
  .object({
    id: uuid,
    name: z.string(),
    // null = no time limit; null = no distance limit — 0010's CHECK requires
    // at least one of the two.
    days: z.number().int().min(1).nullable(),
    maxKm: z.number().int().min(1).nullable(),
  })
  .strict()
  .refine((v) => v.days !== null || v.maxKm !== null, { message: 'warranty_term_needs_a_limit' });
export type WarrantyTermOption = z.infer<typeof WarrantyTermOption>;

export const WarrantyTermList = z.object({ items: z.array(WarrantyTermOption) }).strict();
export type WarrantyTermList = z.infer<typeof WarrantyTermList>;

// -----------------------------------------------------------------------------
// Search
// -----------------------------------------------------------------------------

export const CatalogSearchQuery = z
  .object({
    // Results appear after 2-3 characters (owner decision 16).
    q: z.string().trim().min(2).max(80),
    jobId: uuid,
    limit: z.coerce.number().int().min(1).max(30).default(20),
  })
  .strict();
export type CatalogSearchQuery = z.infer<typeof CatalogSearchQuery>;

/** sets first, then the shop's most used items, then this vehicle's offered items, then the rest. */
export const SearchSection = z.enum(['set', 'frequent', 'offered', 'other']);
export type SearchSection = z.infer<typeof SearchSection>;

export const CatalogHit = z
  .object({
    section: SearchSection,
    // null only for a vehicle_offered_items entry that has no catalog item.
    itemId: uuid.nullable(),
    // Set when section = 'offered': the "เคยเสนอไว้" row to re-add.
    offeredItemId: uuid.nullable(),
    category: z.string().nullable(),
    name: z.string(),
    lineType: LineType,
    unit: z.string().nullable(),
    defaultQty: QtyString,
    isSet: z.boolean(),
    // Number of lines a set expands into (0 for a plain item).
    componentCount: z.number().int().min(0),
    // The price for THIS job's vehicle: model price, else base, else null.
    price: MoneyString.nullable(),
    priceSource: z.enum(['model', 'base', 'none']),
    // catalog_model_prices.id when the price came from the model layer, else null.
    priceRefId: uuid.nullable(),
    warranty: WarrantyTermOption.nullable(),
  })
  .strict();
export type CatalogHit = z.infer<typeof CatalogHit>;

export const CatalogSearchResult = z
  .object({
    items: z.array(CatalogHit),
    // False = the car is not linked to a controlled model yet: prices fall
    // back to base, and the screen offers "เลือกรุ่นรถ".
    vehicleModelLinked: z.boolean(),
  })
  .strict();
export type CatalogSearchResult = z.infer<typeof CatalogSearchResult>;

// -----------------------------------------------------------------------------
// Standard prices
// -----------------------------------------------------------------------------

// The FIRST price someone types for an item on this car. Written only when none
// exists (missing / NULL / 0); a price typed over an existing one never writes
// back (it stays on the quotation line).
export const CatalogPriceCreateInput = z
  .object({
    jobId: uuid,
    itemId: uuid,
    price: MoneyString,
  })
  .strict();
export type CatalogPriceCreateInput = z.infer<typeof CatalogPriceCreateInput>;

export const CatalogPriceScope = z.enum(['model', 'base']);
export type CatalogPriceScope = z.infer<typeof CatalogPriceScope>;

export const CatalogPriceWritten = z
  .object({
    // catalog_model_prices.id for scope 'model'; the item id for scope 'base'.
    priceId: uuid,
    itemId: uuid,
    scope: CatalogPriceScope,
    price: MoneyString,
  })
  .strict();
export type CatalogPriceWritten = z.infer<typeof CatalogPriceWritten>;

// manager and above. `:id` is the catalog_model_prices id (scope 'model') or
// the catalog item id (scope 'base').
export const CatalogPriceFixInput = z
  .object({
    scope: CatalogPriceScope,
    price: MoneyString,
    reason: ChangeReason,
  })
  .strict();
export type CatalogPriceFixInput = z.infer<typeof CatalogPriceFixInput>;

// -----------------------------------------------------------------------------
// Items, duplicates, merge
// -----------------------------------------------------------------------------

export const CatalogItem = z
  .object({
    id: uuid,
    category: z.string(),
    name: z.string(),
    lineType: LineType,
    unit: z.string().nullable(),
    defaultQty: QtyString,
    isSet: z.boolean(),
    basePrice: MoneyString.nullable(),
    warranty: WarrantyTermOption.nullable(),
    isActive: z.boolean(),
  })
  .strict();
export type CatalogItem = z.infer<typeof CatalogItem>;

export const CatalogItemCreateInput = z
  .object({
    category: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(200),
    lineType: LineType.default('part'),
    unit: z.string().trim().min(1).max(30).optional(),
    defaultQty: QtyString.default('1'),
    warrantyTermId: uuid.optional(),
    // The person looked at the "similar to X" warning and still wants a new item.
    confirmNotSimilar: z.boolean().default(false),
  })
  .strict();
export type CatalogItemCreateInput = z.infer<typeof CatalogItemCreateInput>;

export const CatalogSimilarQuery = z
  .object({
    category: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(200),
  })
  .strict();
export type CatalogSimilarQuery = z.infer<typeof CatalogSimilarQuery>;

export const SimilarItem = z
  .object({ id: uuid, category: z.string(), name: z.string(), isSet: z.boolean() })
  .strict();
export type SimilarItem = z.infer<typeof SimilarItem>;

export const CatalogSimilarResult = z.object({ items: z.array(SimilarItem).max(10) }).strict();
export type CatalogSimilarResult = z.infer<typeof CatalogSimilarResult>;

// Merge A into B (manager and above). Per-model prices of A move to B only for
// models B has no price for; where both have one, the manager chooses.
export const CatalogMergeInput = z
  .object({
    intoItemId: uuid,
    reason: ChangeReason.optional(),
    priceConflicts: z
      .array(z.object({ vehicleModelId: uuid, keep: z.enum(['source', 'target']) }).strict())
      .max(2000)
      .default([]),
  })
  .strict();
export type CatalogMergeInput = z.infer<typeof CatalogMergeInput>;

export const CatalogMergeResult = z
  .object({
    sourceItemId: uuid,
    intoItemId: uuid,
    movedPrices: z.number().int().min(0),
    droppedPrices: z.number().int().min(0),
  })
  .strict();
export type CatalogMergeResult = z.infer<typeof CatalogMergeResult>;

// -----------------------------------------------------------------------------
// Controlled vehicle models
// -----------------------------------------------------------------------------

export const VehicleModel = z
  .object({
    id: uuid,
    brand: z.string(),
    name: z.string(),
    yearRange: z.string().nullable(),
  })
  .strict();
export type VehicleModel = z.infer<typeof VehicleModel>;

export const VehicleModelQuery = PageQuery.extend({ q: z.string().trim().min(1).max(80).optional() }).strict();
export type VehicleModelQuery = z.infer<typeof VehicleModelQuery>;

export const VehicleModelPage = z.object({ items: z.array(VehicleModel), total: z.number().int().min(0) }).strict();
export type VehicleModelPage = z.infer<typeof VehicleModelPage>;

export const VehicleModelCreateInput = z
  .object({
    brand: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(120),
    yearRange: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
export type VehicleModelCreateInput = z.infer<typeof VehicleModelCreateInput>;

export const VehicleModelAssignInput = z.object({ vehicleModelId: uuid }).strict();
export type VehicleModelAssignInput = z.infer<typeof VehicleModelAssignInput>;

export const VehicleModelAssigned = z
  .object({ vehicleId: uuid, vehicleModelId: uuid.nullable() })
  .strict();
export type VehicleModelAssigned = z.infer<typeof VehicleModelAssigned>;

// manager and above: cars with no controlled model, grouped by what staff typed.
export const UnmatchedModelGroup = z
  .object({
    brandText: z.string(),
    modelText: z.string(),
    vehicleCount: z.number().int().min(1),
  })
  .strict();
export type UnmatchedModelGroup = z.infer<typeof UnmatchedModelGroup>;

export const UnmatchedModelPage = z
  .object({ items: z.array(UnmatchedModelGroup), total: z.number().int().min(0) })
  .strict();
export type UnmatchedModelPage = z.infer<typeof UnmatchedModelPage>;

// Assign a model to EVERY car typed with this brand/model text (one group).
export const UnmatchedAssignInput = z
  .object({
    brandText: z.string(),
    modelText: z.string(),
    vehicleModelId: uuid,
  })
  .strict();
export type UnmatchedAssignInput = z.infer<typeof UnmatchedAssignInput>;

export const UnmatchedAssignResult = z.object({ updated: z.number().int().min(0) }).strict();
export type UnmatchedAssignResult = z.infer<typeof UnmatchedAssignResult>;

