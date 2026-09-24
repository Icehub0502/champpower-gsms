// The public waiting-room screen — /board, shown on a television in the
// customer lounge, NO login.
//
// This schema is written from scratch, on purpose, and is NOT the /today row
// with fields removed. A schema derived by omission leaks the day someone adds
// a field to the parent and forgets the omit list; a schema that never had the
// field cannot. There is no customer name, phone, price, complaint or photo
// here, and every object is .strict(), so an extra key is a parse FAILURE —
// the route fails closed with a 500 rather than putting a stray field on a
// screen anyone can walk up to (docs/UI-SPEC-FIGMA.md §2, CLAUDE.md §12).
//
// No photo, deliberately: a car photo on an unauthenticated screen needs signed
// URLs and the customer's consent, neither of which exists yet.

import { z } from 'zod';

const isoDateTime = z.string().datetime();

export const PublicBoardCar = z
  .object({
    // What a customer uses to find THEIR car: the number called out, and the plate.
    queueNo: z.number().int().nullable(),
    plate: z.string(),
    province: z.string().nullable(),
    brand: z.string(),
    model: z.string(),
    color: z.string().nullable(),

    bayName: z.string().nullable(),
    status: z.string(),
    statusLabel: z.string(),

    // The estimate as words ("1 ชม. 30 น.") and as minutes, plus the current
    // repair window, so the screen can run the same etaState() countdown the
    // staff screen does. No estimate -> estMinutes 0 and no countdown.
    estLabel: z.string(),
    estMinutes: z.number().int().min(0),
    repairStartedAt: isoDateTime.nullable(),
    repairEndedAt: isoDateTime.nullable(),

    // Handed back today. The screen fades these out; they are gone tomorrow.
    deliveredToday: z.boolean(),
    statusChangedAt: isoDateTime,
  })
  .strict();
export type PublicBoardCar = z.infer<typeof PublicBoardCar>;

// The shop's own bays, from its `bays` rows — not the hard-coded WORK_BAYS
// list, which is one shop's layout and wrong for every other shop.
export const PublicBoardBay = z
  .object({
    name: z.string(),
    inUse: z.boolean(),
  })
  .strict();
export type PublicBoardBay = z.infer<typeof PublicBoardBay>;

export const PublicBoardResponse = z
  .object({
    shopName: z.string(),
    bays: z.array(PublicBoardBay),
    cars: z.array(PublicBoardCar),
    generatedAt: isoDateTime,
  })
  .strict();
export type PublicBoardResponse = z.infer<typeof PublicBoardResponse>;
