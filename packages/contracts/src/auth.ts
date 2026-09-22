// Auth — the shapes apps/web and apps/api both need for sign-in, "who am I",
// switching branch and sign-out.
//
// CLAUDE.md §2: web must never declare its own copy of the API's types, so
// `Role` lives here, not in apps/web/src/hooks/useAuth.ts. The value set is
// mirrored (not imported) from apps/api/src/lib/jwt.ts's `Role`, because that
// module pulls in `jsonwebtoken` and this package must stay pure/runtime-free
// (CLAUDE.md §2 "packages/domain must not import express/react/..." — the
// same rule applies here). If the seven roles in CLAUDE.md §12 ever change,
// update both places.
//
// One thing deliberately absent from every schema below: a refresh token
// field. Since WO-004/T6 it never appears in a JSON body — apps/api/src/
// routes/auth.ts sets it only as an httpOnly+Secure+SameSite=Strict cookie,
// and apps/web never reads or stores it. See CLAUDE.md §12 condition 2 in
// the work order that introduced this file.

import { z } from 'zod';

export const Role = z.enum([
  'owner', 'manager', 'assistant_manager', 'advisor',
  'technician', 'accountant', 'viewer',
]);
export type Role = z.infer<typeof Role>;

export const ShopMembership = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  role: Role,
});
export type ShopMembership = z.infer<typeof ShopMembership>;

export const AuthUser = z.object({
  id: z.string().uuid(),
  loginId: z.string(),
  name: z.string(),
});
export type AuthUser = z.infer<typeof AuthUser>;

// POST /api/auth/login
export const LoginInput = z.object({
  loginId: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
  shopId: z.string().uuid().optional(),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const LoginResponse = z.object({
  accessToken: z.string(),
  user: AuthUser,
  shop: ShopMembership,
  shops: z.array(ShopMembership),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

// POST /api/auth/refresh — body is empty from the browser (the refresh token
// travels as the httpOnly cookie); kept as an object, not `z.void()`, so a
// non-browser caller can still pass shopId to switch branch mid-refresh.
export const RefreshInput = z.object({
  shopId: z.string().uuid().optional(),
});
export type RefreshInput = z.infer<typeof RefreshInput>;

export const RefreshResponse = z.object({
  accessToken: z.string(),
  shop: ShopMembership,
});
export type RefreshResponse = z.infer<typeof RefreshResponse>;

// POST /api/auth/switch-shop
export const SwitchShopInput = z.object({
  shopId: z.string().uuid(),
});
export type SwitchShopInput = z.infer<typeof SwitchShopInput>;

export const SwitchShopResponse = z.object({
  accessToken: z.string(),
  shop: ShopMembership,
});
export type SwitchShopResponse = z.infer<typeof SwitchShopResponse>;

// GET /api/auth/me
export const MeResponse = z.object({
  user: AuthUser,
  shop: ShopMembership,
  shops: z.array(ShopMembership),
});
export type MeResponse = z.infer<typeof MeResponse>;

// POST /api/auth/logout
export const LogoutResponse = z.object({
  ok: z.literal(true),
});
export type LogoutResponse = z.infer<typeof LogoutResponse>;
