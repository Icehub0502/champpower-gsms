import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BRAND_OPTIONS, DEFAULT_COMPLAINTS, isPlateArea } from '@champpower/domain';
import {
  CheckInInput,
  type CheckInResult,
  type CustomerCandidate,
  type LeadSource,
  type VehicleCandidate,
  type VehicleOwnerMismatchError,
} from '@gsms/contracts/index.js';
import { api } from '../../lib/api/client';
import { isSessionCancelled } from '../../lib/api/sessionCancelled';
import { CheckInField } from './CheckInField';
import { CheckInPhotos } from './CheckInPhotos';
import { useCheckInPhotos } from './useCheckInPhotos';
import { LEAD_SOURCE_LABEL, LEAD_SOURCE_ORDER } from './leadSource';
import { Icon } from '../../components/ui/Icon';
import { ProvincePicker } from '../../components/ui/ProvincePicker';
import { OwnerChangeDialog, PickCustomerDialog, VehicleAmbiguousDialog } from './RefusalDialogs';
import { OFF_SCREEN_FIELD_LABEL, REFUSAL_TEXT, readSubmitFailure } from './refusal';
import { digits, useCheckInLookups } from './useCheckInLookups';

interface CheckInPageProps {
  onCreated: (jobId: string) => void;
}

const EMPTY = {
  plate: '',
  province: '',
  mileage: '',
  customerName: '',
  customerPhone: '',
  brand: '',
  model: '',
  color: '',
  year: '',
  queueNo: '',
  symptom: '',
  leadSource: '' as LeadSource | '',
};
type Form = typeof EMPTY;
type FieldKey = keyof Form;

/** What to type, per field — shown in words next to the field, never colour alone. */
const REQUIRED_TEXT: Partial<Record<FieldKey, string>> = {
  plate: 'กรอกทะเบียนรถ',
  mileage: 'กรอกเลขไมล์เป็นตัวเลข เช่น 86240',
  customerName: 'กรอกชื่อลูกค้า',
  brand: 'กรอกยี่ห้อรถ เช่น TOYOTA',
  model: 'กรอกรุ่นรถ เช่น VIOS',
  customerPhone: 'เบอร์โทรไม่ถูกต้อง — ตัวเลข 9–10 หลัก',
  leadSource: 'เลือกว่าลูกค้ารู้จักอู่จากช่องทางไหน — ถ้าไม่รู้ให้เลือก “ไม่ทราบ”',
  queueNo: 'เลขคิวต้องเป็นตัวเลขตั้งแต่ 1 ขึ้นไป',
  year: 'ปีรถยาวเกินไป',
  province: 'รถคันนี้ยังไม่เคยเข้าร้าน กรุณาเลือกจังหวัดจากรายการ',
};

type Dialog =
  | { kind: 'pick'; candidates: CustomerCandidate[]; resubmit: boolean }
  | { kind: 'owner'; refusal: VehicleOwnerMismatchError }
  | { kind: 'vehicle'; candidates: VehicleCandidate[] }
  | null;

interface Answers {
  customerId?: string;
  confirmOwnerChange?: boolean;
  vehicleId?: string;
  confirmNewVehicle?: boolean;
  province?: string;
}

/**
 * รับรถเข้าระบบ — Figma 03 (node 2015:104), fixed against the existing page
 * rather than rewritten (UI-SPEC-FIGMA.md §5). Out of scope: everything on
 * frame 51 (money, parts, approval).
 *
 * The server is the rule for WHO this customer is and WHICH car this is: the
 * form prefills from the lookups, then posts, and the four 409s below are the
 * point of the screen, not edge cases. Every refused submit keeps everything
 * the counter typed. One component tree at every width, so a half-filled form
 * survives an iPad rotation (docs/UI-SPEC-FIGMA.md §4 rule 2).
 */
export function CheckInPage({ onCreated }: CheckInPageProps) {
  const [form, setForm] = useState<Form>(EMPTY);
  const [chips, setChips] = useState<string[]>([]);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  // Answers to earlier 409s. Cleared whenever the fields they answered change:
  // a confirmation given for one owner/phone must not carry over to another.
  const [chosenCustomerId, setChosenCustomerId] = useState<string | null>(null);
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const [chosenVehicleId, setChosenVehicleId] = useState<string | null>(null);
  const [newVehicleConfirmed, setNewVehicleConfirmed] = useState(false);
  // Bumped to move focus to the province picker once it has rendered its error.
  const [focusProvince, setFocusProvince] = useState(0);
  const provinceRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusProvince > 0) provinceRef.current?.focus();
  }, [focusProvince]);
  const lookups = useCheckInLookups();
  const photos = useCheckInPhotos();
  const vehicle = lookups.vehicle;

  function set<K extends FieldKey>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    if (key === 'plate' || key === 'customerPhone' || key === 'customerName') setOwnerConfirmed(false);
    // Which car it is was answered for THIS plate and province only.
    if (key === 'plate' || key === 'province') {
      setChosenVehicleId(null);
      setNewVehicleConfirmed(false);
    }
    if (key === 'customerPhone') setChosenCustomerId(null);
  }

  async function onPlateBlur() {
    const found = await lookups.lookupPlate(form.plate, form.province);
    if (!found) return;
    // Flat and pre-filled, never hidden: a matched car's details stay on
    // screen and editable, so a change of owner is visible to the counter.
    setForm((f) => ({
      ...f,
      province: found.province ?? f.province,
      brand: f.brand || found.brand,
      model: f.model || found.model,
      color: f.color || (found.color ?? ''),
      year: f.year || (found.year ?? ''),
      customerName: f.customerName || (found.customerName ?? ''),
      customerPhone: f.customerPhone || (found.customerPhone ?? ''),
    }));
  }

  // A province chosen for a plate that matched several cars narrows the lookup.
  function onProvinceChange(next: string) {
    set('province', next);
    if (isPlateArea(next) && form.plate.trim() && !vehicle) {
      void lookups.lookupPlate(form.plate, next).then((found) => {
        if (!found) return;
        setForm((f) => ({
          ...f,
          brand: f.brand || found.brand,
          model: f.model || found.model,
          color: f.color || (found.color ?? ''),
          year: f.year || (found.year ?? ''),
          customerName: f.customerName || (found.customerName ?? ''),
          customerPhone: f.customerPhone || (found.customerPhone ?? ''),
        }));
      });
    }
  }

  async function onPhoneBlur() {
    const res = await lookups.lookupPhone(form.customerPhone);
    if (!res) return;
    if (res.kind === 'found' && res.result.name) {
      setForm((f) => (f.customerName ? f : { ...f, customerName: res.result.name ?? '' }));
    } else if (res.kind === 'ambiguous') {
      setDialog({ kind: 'pick', candidates: res.candidates, resubmit: false });
    }
  }

  // Is this customer already on file? Mirrors the server's own rule for a
  // matched car (services/intake.ts): only a phone that contradicts the
  // owner's phone describes someone else — a name never does.
  const phone = digits(form.customerPhone);
  const sameAsOwner = vehicle !== null && (!phone || !digits(vehicle.customerPhone) || phone === digits(vehicle.customerPhone));
  const phoneFound = lookups.phoneLookup?.kind === 'found' && digits(lookups.phoneLookup.phone) === phone;
  const customerKnown = chosenCustomerId !== null || phoneFound || sameAsOwner;
  // CLAUDE.md §5.7: asked once, at the first visit — never of someone on file.
  const askLeadSource = !customerKnown;

  function validate(answers: Answers): CheckInInput | null {
    const next: Partial<Record<FieldKey, string>> = {};
    const mileageDigits = form.mileage.replace(/[\s,]/g, '');
    if (!/^\d+$/.test(mileageDigits)) next.mileage = REQUIRED_TEXT.mileage;
    if (form.queueNo.trim() && !/^\d+$/.test(form.queueNo.trim())) next.queueNo = REQUIRED_TEXT.queueNo;
    // Picking a customer from a 409 answers who they are, so no lead-source question.
    const ask = askLeadSource && !answers.customerId;
    if (ask && !form.leadSource) next.leadSource = REQUIRED_TEXT.leadSource;

    const symptom = [...chips, form.symptom.trim()].filter(Boolean).join(' • ');
    const candidate = {
      plate: form.plate,
      customerName: form.customerName,
      customerPhone: form.customerPhone.trim() || undefined,
      brand: form.brand.trim().toUpperCase(),
      model: form.model.trim().toUpperCase(),
      color: form.color.trim() || undefined,
      year: form.year.trim() || undefined,
      // A car already on file keeps its province — the server never rewrites it.
      province: !vehicle && (answers.province ?? form.province).trim() ? (answers.province ?? form.province) : undefined,
      mileageInKm: next.mileage ? undefined : Number(mileageDigits),
      queueNo: form.queueNo.trim() && !next.queueNo ? Number(form.queueNo.trim()) : undefined,
      symptom: symptom || undefined,
      // In list order: the first is the cover.
      photoFileIds: photos.fileIds.length > 0 ? photos.fileIds : undefined,
      leadSource: ask && form.leadSource ? form.leadSource : undefined,
      customerId: answers.customerId ?? chosenCustomerId ?? undefined,
      confirmOwnerChange: (answers.confirmOwnerChange ?? ownerConfirmed) || undefined,
      vehicleId: answers.vehicleId ?? chosenVehicleId ?? undefined,
      confirmNewVehicle: (answers.confirmNewVehicle ?? newVehicleConfirmed) || undefined,
    };
    // An untouched optional field is OMITTED, never sent as '' (an empty
    // province used to get a bare 400). Keys holding undefined are dropped
    // here rather than trusting JSON.stringify to do it downstream.
    const present = Object.fromEntries(Object.entries(candidate).filter(([, v]) => v !== undefined));
    const parsed = CheckInInput.safeParse(present);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as FieldKey | undefined;
        if (key && key in EMPTY && !next[key]) next[key] = REQUIRED_TEXT[key] ?? 'ข้อมูลนี้ไม่ถูกต้อง';
      }
    }
    setErrors(next);
    if (Object.values(next).some(Boolean) || !parsed.success) {
      setFormError('กรุณาแก้ช่องที่มีข้อความแจ้งเตือนใต้ช่องก่อนบันทึก');
      return null;
    }
    return parsed.data;
  }

  async function submit(answers: Answers = {}) {
    setFormError('');
    // A photo is never silently dropped from the job: wait for uploads still
    // in flight, and make the counter retry or remove one that failed.
    if (photos.pending) {
      setFormError('รอรูปอัปโหลดให้เสร็จก่อน แล้วกดบันทึกอีกครั้ง');
      return;
    }
    if (photos.sessionExpired) {
      setFormError('หมดเวลาการเข้าสู่ระบบ — เข้าสู่ระบบใหม่ แล้วกด “ส่งรูปที่ค้างอีกครั้ง” ก่อนบันทึก');
      return;
    }
    if (photos.failed) {
      setFormError('มีรูปที่อัปโหลดไม่สำเร็จ — กด “ลองใหม่” หรือ “ลบ” ที่รูปนั้นก่อนบันทึก');
      return;
    }
    const input = validate(answers);
    if (!input) return;
    setSubmitting(true);
    try {
      const result = await api.post<CheckInResult>('/api/checkin', input);
      onCreated(result.jobId);
    } catch (err) {
      if (isSessionCancelled(err)) return; // logged out / switched user: no form error
      const failure = readSubmitFailure(err);
      if (failure.kind === 'generic') {
        setFormError(failure.text);
        return;
      }
      const r = failure.refusal;
      switch (r.error) {
        case 'customer_ambiguous':
          setDialog({ kind: 'pick', candidates: r.candidates, resubmit: true });
          break;
        case 'vehicle_owner_mismatch':
          setDialog({ kind: 'owner', refusal: r });
          break;
        case 'intake_details_required': {
          const marked: Partial<Record<FieldKey, string>> = {};
          for (const key of Object.keys(r.fields) as (keyof typeof r.fields)[]) marked[key] = REQUIRED_TEXT[key];
          setErrors((e) => ({ ...e, ...marked }));
          if (marked.province) setFocusProvince((n) => n + 1);
          setFormError('รถคันนี้ยังไม่เคยเข้าร้าน — กรอกช่องที่มีข้อความแจ้งเตือนใต้ช่อง แล้วบันทึกอีกครั้ง');
          break;
        }
        case 'vehicle_ambiguous':
          setDialog({ kind: 'vehicle', candidates: r.candidates });
          break;
        case 'vehicle_required':
          setErrors((e) => ({ ...e, plate: REQUIRED_TEXT.plate }));
          break;
        case 'queue_no_taken':
          setErrors((e) => ({
            ...e,
            queueNo: `${r.queueNo === null ? 'เลขคิวนี้' : `คิว ${r.queueNo}`} มีรถคันอื่นแล้ว — แก้เลขคิว หรือเว้นว่างให้ระบบเลือกให้`,
          }));
          break;
        case 'unknown_vehicle':
          // The chosen car is gone or does not fit this plate: forget the choice,
          // keep everything typed, and let staff look the plate up and choose again.
          setChosenVehicleId(null);
          setFormError(REFUSAL_TEXT.unknown_vehicle);
          break;
        case 'vehicle_plate_mismatch':
          // Nothing is resent by itself. The choice is forgotten so the next save
          // asks again instead of repeating an id the server just refused.
          setChosenVehicleId(null);
          setErrors((e) => ({ ...e, plate: REFUSAL_TEXT.vehicle_plate_mismatch }));
          setFormError(REFUSAL_TEXT.vehicle_plate_mismatch);
          break;
        case 'invalid_request':
          showInvalidRequest(r.fields);
          break;
        default:
          // The other payload-less codes: one plain instruction each (refusal.ts).
          setFormError(REFUSAL_TEXT[r.error]);
      }
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * 400 invalid_request. Each named field is marked next to its input, in this
   * screen's own words (never the server's text, never the value typed); a
   * named field with no input here is listed in the general message instead of
   * being dropped.
   */
  function showInvalidRequest(fields: Record<string, string[]> | undefined) {
    const names = Object.keys(fields ?? {});
    if (names.length === 0) {
      setFormError('ข้อมูลบางช่องไม่ถูกต้อง กรุณาตรวจสอบแล้วบันทึกอีกครั้ง — ข้อมูลที่กรอกไว้ยังอยู่ครบ');
      return;
    }
    const marked: Partial<Record<FieldKey, string>> = {};
    const offScreen: string[] = [];
    for (const name of names) {
      const key = name === 'mileageInKm' ? 'mileage' : name;
      if (key in EMPTY) {
        const k = key as FieldKey;
        marked[k] = REQUIRED_TEXT[k] ?? 'ข้อมูลช่องนี้ไม่ถูกต้อง — ตรวจสอบแล้วกรอกใหม่';
      } else {
        offScreen.push(OFF_SCREEN_FIELD_LABEL[name] ?? `ช่อง “${name}”`);
      }
    }
    setErrors((e) => ({ ...e, ...marked }));
    const parts: string[] = [];
    if (Object.keys(marked).length > 0) parts.push('แก้ช่องที่มีข้อความแจ้งเตือนใต้ช่อง');
    if (offScreen.length > 0) parts.push(`ตรวจสอบ: ${offScreen.join(', ')}`);
    setFormError(`ข้อมูลบางส่วนไม่ถูกต้อง — ${parts.join(' และ')} แล้วบันทึกอีกครั้ง`);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!submitting) void submit();
  }

  function pickCustomer(c: CustomerCandidate, resubmit: boolean) {
    setChosenCustomerId(c.id);
    if (c.name) setForm((f) => ({ ...f, customerName: c.name ?? f.customerName }));
    setDialog(null);
    if (resubmit) void submit({ customerId: c.id });
  }

  function pickVehicle(c: VehicleCandidate) {
    setChosenVehicleId(c.id);
    setDialog(null);
    // Shown, not hidden: the counter sees which car was chosen and can still edit.
    setForm((f) => ({
      ...f,
      province: c.province && isPlateArea(c.province) ? c.province : f.province,
      brand: f.brand || c.brand,
      model: f.model || c.model,
      color: f.color || (c.color ?? ''),
    }));
    void submit({ vehicleId: c.id });
  }

  function searchWithProvince(province: string) {
    setForm((f) => ({ ...f, province }));
    setChosenVehicleId(null);
    setNewVehicleConfirmed(false);
    setDialog(null);
    void submit({ province });
  }

  function confirmNewVehicle(province: string) {
    setForm((f) => ({ ...f, province }));
    setChosenVehicleId(null);
    setNewVehicleConfirmed(true);
    setDialog(null);
    void submit({ province, confirmNewVehicle: true });
  }

  function confirmOwnerChange() {
    setOwnerConfirmed(true);
    setDialog(null);
    void submit({ confirmOwnerChange: true });
  }

  const input = (key: FieldKey, extra: Record<string, unknown> = {}) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => set(key, e.target.value as Form[typeof key]),
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': errors[key] ? `ci-err-${key}` : undefined,
    disabled: submitting,
    ...extra,
  });

  return (
    <div className="page ci-page">
      <header className="ci-header">
        <h1>รับรถเข้าระบบ</h1>
        <p className="page-sub">บันทึกข้อมูลลูกค้า รถ และอาการที่แจ้ง</p>
      </header>

      <form onSubmit={onSubmit} noValidate>
        <section className="card ci-card">
          <h3>ข้อมูลใบรับรถ</h3>
          <p className="ci-card-sub">เริ่มจากข้อมูลจำเป็นก่อน แล้วค่อยเพิ่มรายละเอียด</p>
          <div className="ci-grid ci-grid-3">
            <CheckInField label="ทะเบียนรถ" required error={errors.plate} errorId="ci-err-plate">
              <input className="plate-input" placeholder="1กข1234" autoComplete="off"
                {...input('plate', { onBlur: () => void onPlateBlur(), onChange: (e: { target: { value: string } }) => { set('plate', e.target.value); lookups.plateEdited(e.target.value); } })} />
            </CheckInField>
            <CheckInField label="จังหวัด" errorId="ci-err-province"
              error={errors.province}
              hint={vehicle ? 'รถคันนี้มีในระบบแล้ว — จังหวัดตามที่บันทึกไว้ แก้ที่นี่ไม่ได้'
                : lookups.plateAmbiguous ? 'ทะเบียนนี้มีหลายจังหวัดในระบบ — เลือกจังหวัดเพื่อดึงข้อมูลรถ'
                : 'จำเป็นสำหรับรถที่ยังไม่เคยเข้าร้าน'}>
              <ProvincePicker value={form.province} onChange={onProvinceChange} inputRef={provinceRef}
                disabled={submitting} readOnly={vehicle !== null} invalid={!!errors.province}
                describedBy={errors.province ? 'ci-err-province' : undefined} />
            </CheckInField>
            <CheckInField label="เลขไมล์ (กม.)" required error={errors.mileage} errorId="ci-err-mileage">
              <input inputMode="numeric" placeholder="เช่น 86240" {...input('mileage')} />
            </CheckInField>
          </div>

          {vehicle ? (
            <p className="ci-match" role="status">
              พบรถคันนี้ในระบบ: <b>{vehicle.brand} {vehicle.model}</b>
              {vehicle.customerName && <> — เจ้าของ {vehicle.customerName}</>}. กรอกข้อมูลไว้ให้แล้ว แก้ได้ถ้าไม่ตรง
            </p>
          ) : null}

          <div className="ci-grid ci-grid-2">
            <CheckInField label="ชื่อลูกค้า" required error={errors.customerName} errorId="ci-err-customerName">
              <input autoComplete="off" {...input('customerName')} />
            </CheckInField>
            <CheckInField label="เบอร์โทร" error={errors.customerPhone} errorId="ci-err-customerPhone"
              hint={chosenCustomerId ? 'เลือกลูกค้าจากเบอร์นี้แล้ว' : phoneFound ? 'พบลูกค้าเบอร์นี้ในระบบ' : undefined}>
              <input inputMode="tel" autoComplete="off"
                {...input('customerPhone', { onBlur: () => void onPhoneBlur(), onChange: (e: { target: { value: string } }) => { set('customerPhone', e.target.value); lookups.phoneEdited(e.target.value); } })} />
            </CheckInField>
          </div>

          {askLeadSource && (
            <CheckInField label="ลูกค้ารู้จักอู่จากช่องทางไหน" required error={errors.leadSource}
              errorId="ci-err-leadSource" hint="ถามครั้งเดียวตอนลูกค้ามาครั้งแรก" className="ci-lead">
              <select {...input('leadSource')}>
                <option value="">— เลือก —</option>
                {LEAD_SOURCE_ORDER.map((s) => (
                  <option key={s} value={s}>{LEAD_SOURCE_LABEL[s]}</option>
                ))}
              </select>
            </CheckInField>
          )}
        </section>

        <section className="card ci-card">
          <h3>ข้อมูลรถ</h3>
          <div className="ci-grid ci-grid-4">
            <CheckInField label="ยี่ห้อ" required error={errors.brand} errorId="ci-err-brand">
              <input list="ci-brand-options" autoComplete="off" {...input('brand')} />
            </CheckInField>
            <datalist id="ci-brand-options">
              {BRAND_OPTIONS.map((b) => <option key={b} value={b} />)}
            </datalist>
            <CheckInField label="รุ่น" required error={errors.model} errorId="ci-err-model">
              <input autoComplete="off" {...input('model')} />
            </CheckInField>
            <CheckInField label="สี" errorId="ci-err-color">
              <input {...input('color')} />
            </CheckInField>
            <CheckInField label="ปีรถ" error={errors.year} errorId="ci-err-year">
              <input inputMode="numeric" placeholder="เช่น 2020" {...input('year')} />
            </CheckInField>
          </div>
        </section>

        <section className="card ci-card">
          <div className="ci-symptom-head">
            <h3>อาการที่ลูกค้าแจ้ง</h3>
            <CheckInField label="คิวรถ" error={errors.queueNo} errorId="ci-err-queueNo" className="ci-queue"
              hint="เว้นว่าง = ระบบรันเลขให้">
              <input inputMode="numeric" {...input('queueNo')} />
            </CheckInField>
          </div>
          <CheckInField label="อาการ (พิมพ์เพิ่มได้)" errorId="ci-err-symptom">
            <input placeholder="เช่น พวงมาลัยมีเสียงดังเวลาหักซ้าย" {...input('symptom')} />
          </CheckInField>
          <div className="complaint-chips complaint-chips-scroll" role="group" aria-label="อาการที่พบบ่อย">
            {DEFAULT_COMPLAINTS.map((c) => {
              const on = chips.includes(c);
              return (
                <button key={c} type="button" className={`chip${on ? ' active' : ''}`} aria-pressed={on}
                  disabled={submitting}
                  onClick={() => setChips((p) => (on ? p.filter((x) => x !== c) : [...p, c]))}>
                  {on && <><Icon name="check" size={13} />{' '}</>}{c}
                </button>
              );
            })}
          </div>
        </section>

        <CheckInPhotos photos={photos} disabled={submitting} />

        {formError && <p className="ci-form-error" role="alert"><Icon name="alert" size={15} /><span>{formError}</span></p>}

        <div className="ci-actions">
          <button type="submit" className="btn ci-submit" disabled={submitting || photos.pending}>
            {submitting ? 'กำลังบันทึก…' : photos.pending ? 'รอรูปอัปโหลด…' : 'บันทึกและสร้างใบงาน'}
          </button>
        </div>
      </form>

      {dialog?.kind === 'pick' && (
        <PickCustomerDialog candidates={dialog.candidates} busy={submitting}
          onPick={(c) => pickCustomer(c, dialog.resubmit)} onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === 'vehicle' && (
        <VehicleAmbiguousDialog candidates={dialog.candidates} province={form.province} busy={submitting}
          onPickVehicle={pickVehicle} onPickProvince={searchWithProvince} onNewVehicle={confirmNewVehicle}
          onCancel={() => setDialog(null)} />
      )}
      {dialog?.kind === 'owner' && (
        <OwnerChangeDialog refusal={dialog.refusal} plate={form.plate} busy={submitting}
          onConfirm={confirmOwnerChange} onCancel={() => setDialog(null)} />
      )}
    </div>
  );
}
