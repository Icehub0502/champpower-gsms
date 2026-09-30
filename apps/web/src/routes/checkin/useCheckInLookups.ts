import { useRef, useState } from 'react';
import {
  CustomerAmbiguousError,
  VehicleAmbiguousError,
  thaiPhone,
  type CustomerCandidate,
  type CustomerLookupResult,
  type VehicleLookupResult,
} from '@gsms/contracts/index.js';
import { ApiError, api } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';

export type PhoneLookup =
  | { phone: string; kind: 'found'; result: CustomerLookupResult }
  | { phone: string; kind: 'none' }
  | { phone: string; kind: 'ambiguous'; candidates: CustomerCandidate[] };

/** Digits only — the same comparison the server makes (customersRepo.normalisePhone). */
export function digits(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '');
}

/**
 * The two prefill lookups (routes/checkin.ts): by plate, then by phone.
 *
 * Both are prefill only — the server decides who the customer is again on
 * submit, and refuses (409) rather than guess. A response that arrives after
 * the field has changed is dropped, so a slow lookup never fills in the wrong
 * car. A lookup that fails for any reason other than "not found" leaves the
 * form alone: staff can still type everything by hand.
 */
export function useCheckInLookups() {
  const [vehicle, setVehicle] = useState<VehicleLookupResult | null>(null);
  // The plate is on file in several provinces and none was given: prefill is
  // skipped, and the screen asks for the province instead of guessing a car.
  const [plateAmbiguous, setPlateAmbiguous] = useState(false);
  const [phoneLookup, setPhoneLookup] = useState<PhoneLookup | null>(null);
  const latestPlate = useRef('');
  const latestPhone = useRef('');

  async function lookupPlate(plate: string, province?: string): Promise<VehicleLookupResult | null> {
    const key = plate.trim();
    latestPlate.current = key;
    if (!key) {
      setVehicle(null);
      setPlateAmbiguous(false);
      return null;
    }
    try {
      const found = await api.get<VehicleLookupResult>(
        `/api/checkin/vehicle-lookup?plate=${encodeURIComponent(key)}${province ? `&province=${encodeURIComponent(province)}` : ''}`,
      );
      if (latestPlate.current !== key) return null;
      setVehicle(found);
      setPlateAmbiguous(false);
      return found;
    } catch (err) {
      if (isSessionCancelled(err) || latestPlate.current !== key) return null;
      if (err instanceof ApiError && err.status === 404) {
        setVehicle(null);
        setPlateAmbiguous(false);
      } else if (err instanceof ApiError && err.status === 409 && VehicleAmbiguousError.safeParse(err.body).success) {
        // Read through the schema only (see refusal.ts).
        setVehicle(null);
        setPlateAmbiguous(true);
      }
      return null;
    }
  }

  /** Forget the matched car when the plate is edited away from it. */
  function plateEdited(plate: string) {
    latestPlate.current = plate.trim();
    setPlateAmbiguous(false);
    if (vehicle && digitsAndLetters(vehicle.plate) !== digitsAndLetters(plate)) setVehicle(null);
  }

  async function lookupPhone(phone: string): Promise<PhoneLookup | null> {
    const key = phone.trim();
    latestPhone.current = key;
    // Only a number the contract would accept is worth asking about.
    if (!thaiPhone.safeParse(key).success) {
      setPhoneLookup(null);
      return null;
    }
    let next: PhoneLookup | null = null;
    try {
      const result = await api.get<CustomerLookupResult>(
        `/api/checkin/customer-lookup?phone=${encodeURIComponent(key)}`,
      );
      next = { phone: key, kind: 'found', result };
    } catch (err) {
      if (isSessionCancelled(err)) return null; // no state change for a cancelled lookup
      if (err instanceof ApiError && err.status === 404) next = { phone: key, kind: 'none' };
      else if (err instanceof ApiError && err.status === 409) {
        // Read through the schema only — never cast (see refusal.ts).
        const parsed = CustomerAmbiguousError.safeParse(err.body);
        if (parsed.success) next = { phone: key, kind: 'ambiguous', candidates: parsed.data.candidates };
      }
    }
    if (latestPhone.current !== key) return null;
    setPhoneLookup(next);
    // W4: held-deposit lookup by phone — the phone is known at this point, so
    // this is where the counter must be warned about a deposit still `held`
    // for this customer (CLAUDE.md §5.4 item 3). Not built: the deposit module
    // does not exist until W4. Marker kept so nobody ships believing it happens.
    return next;
  }

  function phoneEdited(phone: string) {
    latestPhone.current = phone.trim();
    if (phoneLookup && phoneLookup.phone !== phone.trim()) setPhoneLookup(null);
  }

  return { vehicle, plateAmbiguous, phoneLookup, lookupPlate, plateEdited, lookupPhone, phoneEdited };
}

function digitsAndLetters(v: string): string {
  return v.replace(/[\s-]/g, '').toUpperCase();
}
