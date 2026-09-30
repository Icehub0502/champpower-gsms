// @vitest-environment happy-dom
/**
 * The check-in screen's point is the server's refusals, so that is what is
 * tested: owner change, ambiguous customer, missing details, a taken queue
 * number, a malformed refusal body — plus lead source only for a new
 * customer, and a half-filled form surviving a width change (iPad rotation).
 *
 * The API client is mocked, but ApiError is the REAL class, so the page reads
 * `err.body` exactly as it will in production: through safeParse.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VehicleLookupResult } from '@gsms/contracts/index.js';
import { BREAKPOINTS } from '../../lib/breakpoints';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiUpload = vi.fn();
vi.mock('../../lib/api/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/api/client')>();
  return { ...real, api: { get: (...a: unknown[]) => apiGet(...a), post: (...a: unknown[]) => apiPost(...a), upload: (...a: unknown[]) => apiUpload(...a) } };
});

// happy-dom has no canvas: resizing is compressImage.ts's concern, not this screen's.
vi.mock('../../lib/compressImage', () => ({ resizeImageToBlob: async (f: Blob) => new Blob([f], { type: 'image/jpeg' }) }));

const { ApiError } = await import('../../lib/api/client');
const { SessionCancelledError } = await import('../../lib/api/sessionCancelled');
const { CheckInPage } = await import('./CheckInPage');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER_ID = '00000000-0000-4000-8000-0000000000a1';
const VEHICLE: VehicleLookupResult = {
  vehicleId: '00000000-0000-4000-8000-0000000000b1',
  customerId: OWNER_ID,
  plate: '1กข1234',
  province: 'กรุงเทพมหานคร',
  brand: 'TOYOTA',
  model: 'VIOS',
  color: 'ขาว',
  year: '2018',
  customerName: 'สมชาย',
  customerPhone: '0811111111',
};
const RESULT = {
  jobId: '00000000-0000-4000-8000-0000000000c1',
  queueNo: 3,
  jobDate: '2026-09-26',
  customerId: OWNER_ID,
  vehicleId: VEHICLE.vehicleId,
};

const notFound = () => Promise.reject(new ApiError(404, 'not_found', { error: 'not_found' }));
const refused = (body: unknown, status = 409) => Promise.reject(new ApiError(status, 'x', body));

let container: HTMLDivElement;
let root: Root;
const onCreated = vi.fn();

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiUpload.mockReset();
  onCreated.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<CheckInPage onCreated={onCreated} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function field(label: string): HTMLInputElement | HTMLSelectElement {
  const lbl = Array.from(container.querySelectorAll('label.field')).find((l) =>
    l.querySelector('.ci-field-label')?.textContent?.startsWith(label),
  );
  const el = lbl?.querySelector('input, select');
  if (!el) throw new Error(`no field "${label}"`);
  return el as HTMLInputElement | HTMLSelectElement;
}

function type(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

async function blur(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function button(text: string): HTMLButtonElement {
  const all = Array.from(document.querySelectorAll('button'));
  const b =
    all.find((x) => x.getAttribute('aria-label') === text) ??
    all.find((x) => x.textContent?.trim() === text) ??
    all.find((x) => x.textContent?.includes(text));
  if (!b) throw new Error(`no button "${text}"`);
  return b as HTMLButtonElement;
}

async function submit() {
  await act(async () => {
    button('บันทึกและสร้างใบงาน').click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** A matched car: plate typed and looked up, mileage filled. */
async function fillMatched() {
  apiGet.mockResolvedValueOnce(VEHICLE);
  act(() => type(field('ทะเบียนรถ'), '1กข1234'));
  await blur(field('ทะเบียนรถ'));
  act(() => type(field('เลขไมล์'), '86240'));
}

/** A car and customer nobody has seen. */
async function fillNew() {
  apiGet.mockImplementation(notFound);
  act(() => type(field('ทะเบียนรถ'), '9ขข9999'));
  await blur(field('ทะเบียนรถ'));
  act(() => {
    type(field('เลขไมล์'), '1200');
    type(field('ชื่อลูกค้า'), 'วิไล');
    type(field('ยี่ห้อ'), 'honda');
    type(field('รุ่น'), 'city');
  });
}

describe('lead source', () => {
  it('is asked, and required, for a new customer — with ไม่ทราบ as a real option', async () => {
    await fillNew();
    const select = field('ลูกค้ารู้จักอู่จากช่องทางไหน') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toContain('ไม่ทราบ');

    await submit();
    expect(apiPost).not.toHaveBeenCalled();
    expect(container.textContent).toContain('ถ้าไม่รู้ให้เลือก “ไม่ทราบ”');

    apiPost.mockResolvedValueOnce(RESULT);
    act(() => type(field('ลูกค้ารู้จักอู่จากช่องทางไหน'), 'unknown'));
    await submit();
    expect(apiPost.mock.calls[0]![1]).toMatchObject({ leadSource: 'unknown', brand: 'HONDA', model: 'CITY' });
    expect(onCreated).toHaveBeenCalledWith(RESULT.jobId);
  });

  it('is not asked of a customer already on file (matched car, same owner)', async () => {
    await fillMatched();
    expect(container.textContent).not.toContain('ลูกค้ารู้จักอู่จากช่องทางไหน');
    // Flat and pre-filled, not hidden: the owner's details are on screen and editable.
    expect(field('ชื่อลูกค้า').value).toBe('สมชาย');
    expect(field('ยี่ห้อ').value).toBe('TOYOTA');
  });
});

describe('empty optional fields are omitted, never sent as ""', () => {
  it('no province/phone/color/year/symptom/queueNo keys for untouched fields', async () => {
    await fillNew();
    act(() => type(field('ลูกค้ารู้จักอู่จากช่องทางไหน'), 'page'));
    apiPost.mockResolvedValueOnce(RESULT);
    await submit();
    const sent = apiPost.mock.calls[0]![1] as Record<string, unknown>;
    for (const k of ['province', 'customerPhone', 'color', 'year', 'symptom', 'queueNo', 'customerId', 'confirmOwnerChange']) {
      expect(sent, k).not.toHaveProperty(k);
    }
  });
});

describe('409 vehicle_owner_mismatch', () => {
  it('shows both names, sends nothing more until confirmed, then resends with confirmOwnerChange', async () => {
    await fillMatched();
    apiGet.mockImplementation(notFound); // the new phone is nobody on file
    act(() => type(field('เบอร์โทร'), '0822222222'));
    act(() => type(field('ชื่อลูกค้า'), 'มานี'));
    act(() => type(field('ลูกค้ารู้จักอู่จากช่องทางไหน'), 'referral'));

    apiPost.mockImplementationOnce(() =>
      refused({
        error: 'vehicle_owner_mismatch',
        message: 'x',
        vehicleId: VEHICLE.vehicleId,
        currentOwner: { id: OWNER_ID, name: 'สมชาย' },
        newOwner: { id: null, name: 'มานี' },
      }),
    );
    await submit();

    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('สมชาย');
    expect(dialog.textContent).toContain('มานี');
    expect(dialog.textContent).toContain('เปลี่ยนเจ้าของแล้วใช่ไหม');
    expect(apiPost).toHaveBeenCalledTimes(1);

    apiPost.mockResolvedValueOnce(RESULT);
    await act(async () => {
      button('ใช่ เปลี่ยนเจ้าของเป็น มานี').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(apiPost.mock.calls[1]![1]).toMatchObject({ confirmOwnerChange: true, customerName: 'มานี' });
    expect(onCreated).toHaveBeenCalledWith(RESULT.jobId);
  });

  it('"ไม่ใช่" backs out without resending, and keeps what was typed', async () => {
    await fillMatched();
    apiPost.mockImplementationOnce(() =>
      refused({
        error: 'vehicle_owner_mismatch', message: 'x', vehicleId: VEHICLE.vehicleId,
        currentOwner: { id: OWNER_ID, name: 'สมชาย' }, newOwner: { id: null, name: 'สมชาย' },
      }),
    );
    await submit();
    await act(async () => { button('ไม่ใช่ — กลับไปแก้').click(); });
    expect(apiPost).toHaveBeenCalledTimes(1);
    expect(field('เลขไมล์').value).toBe('86240');
  });
});

describe('409 customer_ambiguous', () => {
  it('lists the candidates by name and resends with the one the counter picked — never the first', async () => {
    await fillNew();
    act(() => type(field('ลูกค้ารู้จักอู่จากช่องทางไหน'), 'line'));
    apiPost.mockImplementationOnce(() =>
      refused({
        error: 'customer_ambiguous', message: 'x',
        candidates: [
          { id: '00000000-0000-4000-8000-0000000000d1', name: 'วิไล ศรีสุข' },
          { id: '00000000-0000-4000-8000-0000000000d2', name: 'วิไล ทองดี' },
        ],
      }),
    );
    await submit();
    expect(document.body.textContent).toContain('วิไล ศรีสุข');
    expect(apiPost).toHaveBeenCalledTimes(1);

    apiPost.mockResolvedValueOnce(RESULT);
    await act(async () => {
      button('วิไล ทองดี').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(apiPost.mock.calls[1]![1]).toMatchObject({ customerId: '00000000-0000-4000-8000-0000000000d2' });
  });
});

describe('other refusals keep everything typed', () => {
  it('intake_details_required marks exactly the named fields, in words', async () => {
    await fillMatched();
    apiPost.mockImplementationOnce(() =>
      refused({ error: 'intake_details_required', message: 'x', fields: { model: ['required'] } }),
    );
    await submit();
    const errs = Array.from(container.querySelectorAll('.ci-field-error')).map((e) => e.textContent);
    expect(errs).toEqual(['⚠ กรอกรุ่นรถ เช่น VIOS']);
    expect(field('ชื่อลูกค้า').value).toBe('สมชาย');
  });

  it('queue_no_taken names the number on the queue field and keeps the rest', async () => {
    await fillMatched();
    act(() => type(field('คิวรถ'), '7'));
    apiPost.mockImplementationOnce(() => refused({ error: 'queue_no_taken', message: 'x', queueNo: 7 }));
    await submit();
    expect(container.textContent).toContain('คิว 7 มีรถคันอื่นแล้ว');
    expect(field('คิวรถ').value).toBe('7');
    expect(field('เลขไมล์').value).toBe('86240');
  });
});

describe('a malformed refusal body is an unknown error — never trusted, never half-rendered', () => {
  const malformed: [string, unknown][] = [
    ['customer_ambiguous with a phone leaked onto a candidate', {
      error: 'customer_ambiguous', message: 'x',
      candidates: [
        { id: '00000000-0000-4000-8000-0000000000d1', name: 'A', phone: '0811111111' },
        { id: '00000000-0000-4000-8000-0000000000d2', name: 'B' },
      ],
    }],
    ['vehicle_owner_mismatch missing currentOwner', {
      error: 'vehicle_owner_mismatch', message: 'x', vehicleId: VEHICLE.vehicleId, newOwner: { id: null, name: 'B' },
    }],
    ['intake_details_required with an unknown field', {
      error: 'intake_details_required', message: 'x', fields: { plateColour: ['required'] },
    }],
    ['queue_no_taken with a string number', { error: 'queue_no_taken', message: 'x', queueNo: '7' }],
    ['not JSON at all', undefined],
  ];

  for (const [name, body] of malformed) {
    it(name, async () => {
      await fillMatched();
      apiPost.mockImplementationOnce(() => refused(body));
      await submit();
      expect(document.querySelector('.modal-backdrop')).toBeNull();
      expect(container.querySelector('.ci-form-error')?.textContent).toContain('บันทึกไม่สำเร็จ กรุณาลองใหม่');
      expect(container.textContent).not.toContain('0811111111');
      expect(field('เลขไมล์').value).toBe('86240');
    });
  }
});

describe('rotation', () => {
  it('a half-filled form keeps its values and its input nodes across every breakpoint', async () => {
    await fillNew();
    act(() => type(field('ลูกค้ารู้จักอู่จากช่องทางไหน'), 'google'));
    const nodes = ['ทะเบียนรถ', 'ชื่อลูกค้า', 'รุ่น', 'ลูกค้ารู้จักอู่จากช่องทางไหน'].map(field);
    const html = container.innerHTML;
    const setViewport = (width: number) =>
      (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } })
        .happyDOM.setViewport({ width, height: 900 });
    for (const w of [390, BREAKPOINTS.tablet, 820, BREAKPOINTS.tabletWide, 1180, BREAKPOINTS.desktop, 1440, 820, 390]) {
      act(() => setViewport(w));
      expect(['ทะเบียนรถ', 'ชื่อลูกค้า', 'รุ่น', 'ลูกค้ารู้จักอู่จากช่องทางไหน'].map(field)).toEqual(nodes);
      expect(container.innerHTML, `DOM differs at ${w}px`).toBe(html);
    }
    expect(field('ทะเบียนรถ').value).toBe('9ขข9999');
    expect(field('ลูกค้ารู้จักอู่จากช่องทางไหน').value).toBe('google');
  });
});

describe('photos', () => {
  const ID1 = '00000000-0000-4000-8000-0000000000e1';
  const ID2 = '00000000-0000-4000-8000-0000000000e2';
  const uploaded = (id: string) => ({ id, kind: 'checkin_photo', mime: 'image/jpeg', bytes: 3 });

  function pick(names: string[]) {
    const input = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]')).find((i) => i.multiple)!;
    const files = names.map((n) => new File([new Uint8Array([0xff, 0xd8, 0xff])], n, { type: 'image/jpeg' }));
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('camera and gallery are two inputs into one list; the camera one opens the rear camera', () => {
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
    expect(inputs).toHaveLength(2);
    expect(inputs.some((i) => i.getAttribute('capture') === 'environment')).toBe(true);
  });

  it('uploads each pick as checkin_photo via api.upload and sends the ids in list order (first = cover)', async () => {
    await fillMatched();
    apiUpload.mockResolvedValueOnce(uploaded(ID1)).mockResolvedValueOnce(uploaded(ID2));
    await act(async () => { pick(['a.jpg', 'b.jpg']); await new Promise((r) => setTimeout(r, 0)); });

    expect(apiUpload).toHaveBeenCalledTimes(2);
    const [path, fd] = apiUpload.mock.calls[0] as [string, FormData];
    expect(path).toBe('/api/files');
    expect(fd.get('kind')).toBe('checkin_photo');
    expect(fd.get('file')).toBeInstanceOf(Blob);
    expect(container.querySelector('.ci-photo-cover')).not.toBeNull();

    // Move the second photo in front: it becomes the cover.
    await act(async () => { button('เลื่อนรูปที่ 2 ไปก่อนหน้า').click(); });
    apiPost.mockResolvedValueOnce(RESULT);
    await submit();
    expect(apiPost.mock.calls[0]![1]).toMatchObject({ photoFileIds: [ID2, ID1] });
  });

  it('the submit waits for an upload still in flight', async () => {
    await fillMatched();
    let finish!: (v: unknown) => void;
    apiUpload.mockReturnValueOnce(new Promise((r) => { finish = r; }));
    await act(async () => { pick(['a.jpg']); await new Promise((r) => setTimeout(r, 0)); });

    const btn = Array.from(container.querySelectorAll('button[type="submit"]'))[0] as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('รอรูปอัปโหลด');

    await act(async () => { finish(uploaded(ID1)); await new Promise((r) => setTimeout(r, 0)); });
    expect(btn.disabled).toBe(false);
  });

  it('a failed upload keeps the form and the other photos; submit is held until it is retried or removed', async () => {
    await fillMatched();
    apiUpload.mockResolvedValueOnce(uploaded(ID1)).mockRejectedValueOnce(new ApiError(413, 'file_too_large'));
    await act(async () => { pick(['ok.jpg', 'big.jpg']); await new Promise((r) => setTimeout(r, 0)); });

    expect(container.textContent).toContain('⚠ อัปโหลดไม่สำเร็จ');
    expect(container.querySelectorAll('.ci-photo')).toHaveLength(2);
    expect(field('เลขไมล์').value).toBe('86240');

    await submit();
    expect(apiPost).not.toHaveBeenCalled();
    expect(container.textContent).toContain('มีรูปที่อัปโหลดไม่สำเร็จ');

    await act(async () => { button('ลบรูปที่ 2').click(); });
    apiPost.mockResolvedValueOnce(RESULT);
    await submit();
    expect(apiPost.mock.calls[0]![1]).toMatchObject({ photoFileIds: [ID1] });
  });
});

describe('photos — session expired mid-upload', () => {
  const ID = (n: number) => `00000000-0000-4000-8000-0000000000f${n}`;

  function pickThree() {
    const input = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]')).find((i) => i.multiple)!;
    const files = ['a', 'b', 'c'].map((n) => new File([new Uint8Array([0xff, 0xd8, 0xff])], `${n}.jpg`, { type: 'image/jpeg' }));
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('three concurrent 401s (failed shared refresh) show ONE session message and keep all three photos for a retry', async () => {
    await fillMatched();
    apiUpload.mockImplementation(() => Promise.reject(new ApiError(401, 'unauthorized')));
    await act(async () => { pickThree(); await new Promise((r) => setTimeout(r, 0)); });

    expect(apiUpload).toHaveBeenCalledTimes(3);
    expect(container.querySelectorAll('.ci-photo-session')).toHaveLength(1);
    expect(container.textContent).not.toContain('อัปโหลดไม่สำเร็จ'); // no per-photo error stack
    expect(container.querySelectorAll('.ci-photo')).toHaveLength(3);
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(field('เลขไมล์').value).toBe('86240');

    // Submit is held with the session message, not sent.
    await submit();
    expect(apiPost).not.toHaveBeenCalled();
    expect(container.textContent).toContain('หมดเวลาการเข้าสู่ระบบ');

    // Signed in again (e.g. another tab): one button resends all three, in order.
    apiUpload.mockReset();
    apiUpload
      .mockResolvedValueOnce({ id: ID(1), kind: 'checkin_photo', mime: 'image/jpeg', bytes: 3 })
      .mockResolvedValueOnce({ id: ID(2), kind: 'checkin_photo', mime: 'image/jpeg', bytes: 3 })
      .mockResolvedValueOnce({ id: ID(3), kind: 'checkin_photo', mime: 'image/jpeg', bytes: 3 });
    await act(async () => {
      button('ส่งรูปที่ค้างอีกครั้ง').click();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(apiUpload).toHaveBeenCalledTimes(3);
    expect(container.querySelector('.ci-photo-session')).toBeNull();

    apiPost.mockResolvedValueOnce(RESULT);
    await submit();
    expect(apiPost.mock.calls[0]![1]).toMatchObject({ photoFileIds: [ID(1), ID(2), ID(3)] });
  });
});

describe('every refusal code has its own instruction', () => {
  const payloadless: [string, number, string][] = [
    ['unknown_bay', 400, 'ช่องซ่อมที่เลือกไม่มีในสาขานี้แล้ว'],
    ['unknown_file', 400, 'มีรูปที่ส่งไปไม่ถึงระบบ'],
    ['booking_not_found', 404, 'ไม่พบใบนัดนี้ในสาขา'],
    ['booking_already_arrived', 409, 'ใบนัดนี้เปิดงานไปแล้ว'],
    ['booking_not_open', 409, 'ใบนัดนี้ถูกยกเลิกหรือถูกบันทึกว่าไม่มาแล้ว'],
    ['job_number_series_missing', 500, 'ไม่ใช่ความผิดของคุณ กรุณาแจ้งผู้จัดการ'],
  ];

  for (const [code, status, text] of payloadless) {
    it(`${code} (${status})`, async () => {
      await fillMatched();
      apiPost.mockImplementationOnce(() => refused({ error: code, message: 'server text' }, status));
      await submit();
      const shown = container.querySelector('.ci-form-error')?.textContent ?? '';
      expect(shown).toContain(text);
      expect(shown).not.toContain('server text');
      expect(document.querySelector('.modal-backdrop')).toBeNull();
      expect(field('เลขไมล์').value).toBe('86240');
    });
  }

  it('vehicle_required marks the plate', async () => {
    await fillMatched();
    apiPost.mockImplementationOnce(() => refused({ error: 'vehicle_required', message: 'x' }));
    await submit();
    expect(Array.from(container.querySelectorAll('.ci-field-error')).map((e) => e.textContent)).toEqual(['⚠ กรอกทะเบียนรถ']);
  });
});

describe('400 invalid_request', () => {
  it('marks a named field that is on the form, and lists one that is not — never echoing a typed value', async () => {
    await fillMatched();
    act(() => type(field('เบอร์โทร'), '0811111111'));
    apiPost.mockImplementationOnce(() =>
      refused({
        error: 'invalid_request',
        message: 'x',
        fields: { customerPhone: ['invalid_phone 0811111111'], mileageInKm: ['too_big'], jobDate: ['invalid_date'] },
      }, 400),
    );
    await submit();
    const errs = Array.from(container.querySelectorAll('.ci-field-error')).map((e) => e.textContent);
    expect(errs).toContain('⚠ เบอร์โทรไม่ถูกต้อง — ตัวเลข 9–10 หลัก');
    expect(errs).toContain('⚠ กรอกเลขไมล์เป็นตัวเลข เช่น 86240');
    const general = container.querySelector('.ci-form-error')?.textContent ?? '';
    expect(general).toContain('วันที่รับรถ'); // no input on screen — named, not dropped
    // Neither the server's field text nor the typed value comes back into the page's messages.
    const messages = Array.from(container.querySelectorAll('.ci-field-error, .ci-form-error')).map((e) => e.textContent).join(' ');
    expect(messages).not.toContain('0811111111');
    expect(messages).not.toContain('invalid_phone');
    expect(field('เบอร์โทร').value).toBe('0811111111');
  });

  it('an unknown field name is still named in the general message rather than dropped', async () => {
    await fillMatched();
    apiPost.mockImplementationOnce(() =>
      refused({ error: 'invalid_request', message: 'x', fields: { somethingNew: ['bad'] } }, 400),
    );
    await submit();
    expect(container.querySelector('.ci-form-error')?.textContent).toContain('ช่อง “somethingNew”');
  });

  it('with no fields: a clear general message', async () => {
    await fillMatched();
    apiPost.mockImplementationOnce(() => refused({ error: 'invalid_request', message: 'x' }, 400));
    await submit();
    expect(container.querySelector('.ci-form-error')?.textContent).toContain('ข้อมูลบางช่องไม่ถูกต้อง');
  });

  it('a malformed invalid_request body (fields not a map of string arrays) is the generic error', async () => {
    await fillMatched();
    apiPost.mockImplementationOnce(() =>
      refused({ error: 'invalid_request', message: 'x', fields: { customerPhone: 'bad' } }, 400),
    );
    await submit();
    expect(container.querySelector('.ci-form-error')?.textContent).toContain('บันทึกไม่สำเร็จ กรุณาลองใหม่');
    expect(container.querySelectorAll('.ci-field-error')).toHaveLength(0);
  });
});

describe('province picker and vehicle_ambiguous', () => {
  const V1 = '00000000-0000-4000-8000-0000000000f1';
  const V2 = '00000000-0000-4000-8000-0000000000f2';
  const ambiguous = () =>
    refused({
      error: 'vehicle_ambiguous',
      message: 'x',
      candidates: [
        { id: V1, province: 'ระยอง', brand: 'HONDA', model: 'CITY', color: 'ดำ' },
        { id: V2, province: 'ชลบุรี', brand: 'TOYOTA', model: 'YARIS', color: null },
      ],
    });
  const pickProvince = (text: string) => {
    const el = field('จังหวัด');
    act(() => type(el, text));
  };
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  async function newCarRefused() {
    await fillNew();
    act(() => type(field('ลูกค้ารู้จักอู่จากช่องทางไหน'), 'page'));
    apiPost.mockImplementationOnce(ambiguous);
    await submit();
  }

  it('sends the province chosen from the picker, and the plate lookup carries it', async () => {
    await fillNew();
    act(() => type(field('ลูกค้ารู้จักอู่จากช่องทางไหน'), 'page'));
    pickProvince('ระยอง');
    await settle();
    apiPost.mockResolvedValueOnce(RESULT);
    await submit();
    expect(apiPost.mock.calls[0]![1]).toMatchObject({ province: 'ระยอง' });

    apiGet.mockClear();
    pickProvince('ชลบุรี');
    await settle();
    expect(apiGet.mock.calls[0]![0]).toContain('province=' + encodeURIComponent('ชลบุรี'));
  });

  it('never sends half-typed text as a province', async () => {
    await fillNew();
    act(() => type(field('ลูกค้ารู้จักอู่จากช่องทางไหน'), 'page'));
    pickProvince('ระย');
    apiPost.mockResolvedValueOnce(RESULT);
    await submit();
    expect(apiPost.mock.calls[0]![1]).not.toHaveProperty('province');
  });

  it('intake_details_required naming province marks the picker in words and focuses it', async () => {
    await fillNew();
    act(() => type(field('ลูกค้ารู้จักอู่จากช่องทางไหน'), 'page'));
    apiPost.mockImplementationOnce(() =>
      refused({ error: 'intake_details_required', message: 'x', fields: { province: ['required'] } }),
    );
    await submit();
    expect(container.textContent).toContain('⚠ รถคันนี้ยังไม่เคยเข้าร้าน กรุณาเลือกจังหวัด');
    expect(field('จังหวัด').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field('จังหวัด'));
  });

  it('ambiguous dialog shows each candidate with province, and no owner data', async () => {
    await newCarRefused();
    const cards = Array.from(document.querySelectorAll('.ci-vehicle-card'));
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelector('.ci-vehicle-province')!.textContent).toBe('ระยอง');
    expect(cards[0]!.textContent).toContain('HONDA CITY');
    expect(document.querySelector('.modal-card')!.textContent).not.toContain('วิไล');
  });

  it('"คันนี้" resends with vehicleId', async () => {
    await newCarRefused();
    apiPost.mockResolvedValueOnce(RESULT);
    await act(async () => { button('คันนี้ — ชลบุรี TOYOTA YARIS').click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(apiPost.mock.calls[1]![1]).toMatchObject({ vehicleId: V2 });
    expect(apiPost.mock.calls[1]![1]).not.toHaveProperty('confirmNewVehicle');
  });

  it('"เป็นรถคันใหม่" needs a province, then resends with confirmNewVehicle', async () => {
    await newCarRefused();
    expect(button('เป็นรถคันใหม่').disabled).toBe(true);
    const dlgInput = document.querySelector<HTMLInputElement>('.modal-card input[role="combobox"]')!;
    act(() => type(dlgInput, 'นครปฐม'));
    expect(button('เป็นรถคันใหม่').disabled).toBe(false);
    apiPost.mockResolvedValueOnce(RESULT);
    await act(async () => { button('เป็นรถคันใหม่').click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(apiPost.mock.calls[1]![1]).toMatchObject({ confirmNewVehicle: true, province: 'นครปฐม' });
    expect(apiPost.mock.calls[1]![1]).not.toHaveProperty('vehicleId');
  });

  it('choosing a province in the dialog resends with that province only', async () => {
    await newCarRefused();
    const dlgInput = document.querySelector<HTMLInputElement>('.modal-card input[role="combobox"]')!;
    act(() => type(dlgInput, 'ระยอง'));
    apiPost.mockResolvedValueOnce(RESULT);
    await act(async () => { button('ค้นหาด้วยจังหวัดนี้').click(); await new Promise((r) => setTimeout(r, 0)); });
    const sent = apiPost.mock.calls[1]![1] as Record<string, unknown>;
    expect(sent.province).toBe('ระยอง');
    expect(sent).not.toHaveProperty('vehicleId');
    expect(sent).not.toHaveProperty('confirmNewVehicle');
  });

  it('unknown_vehicle shows one plain message, forgets the chosen car and keeps the form', async () => {
    await newCarRefused();
    apiPost.mockImplementationOnce(() => refused({ error: 'unknown_vehicle', message: 'x' }, 400));
    await act(async () => { button('คันนี้ — ชลบุรี TOYOTA YARIS').click(); await new Promise((r) => setTimeout(r, 0)); });
    expect(apiPost.mock.calls[1]![1]).toMatchObject({ vehicleId: V2 });
    expect(container.querySelector('.ci-form-error')?.textContent).toContain('ไม่พบรถคันที่เลือก กรุณาค้นหาทะเบียนใหม่');
    expect(field('ทะเบียนรถ').value).toBe('9ขข9999');
    expect(field('ชื่อลูกค้า').value).toBe('วิไล');
    // The next submit no longer carries the old choice.
    apiPost.mockResolvedValueOnce(RESULT);
    await submit();
    expect(apiPost.mock.calls[2]![1]).not.toHaveProperty('vehicleId');
  });

  it('vehicle_plate_mismatch marks the plate, keeps the form, and resends nothing by itself', async () => {
    await newCarRefused();
    apiPost.mockImplementationOnce(() => refused({ error: 'vehicle_plate_mismatch', message: 'x' }));
    await act(async () => { button('คันนี้ — ชลบุรี TOYOTA YARIS').click(); await new Promise((r) => setTimeout(r, 0)); });
    const msg = 'ทะเบียนที่พิมพ์ไม่ตรงกับรถที่เลือก กรุณาตรวจทะเบียนหรือเลือกรถใหม่';
    expect(container.querySelector('.ci-form-error')?.textContent).toContain(msg);
    expect(container.querySelector('#ci-err-plate')?.textContent).toContain(msg);
    expect(field('ทะเบียนรถ').value).toBe('9ขข9999');
    expect(field('ชื่อลูกค้า').value).toBe('วิไล');
    expect(apiPost).toHaveBeenCalledTimes(2);
  });

  it('a vehicle_ambiguous body with an owner field is an unknown error, no dialog', async () => {
    await fillNew();
    act(() => type(field('ลูกค้ารู้จักอู่จากช่องทางไหน'), 'page'));
    apiPost.mockImplementationOnce(() =>
      refused({ error: 'vehicle_ambiguous', message: 'x', candidates: [{ id: V1, province: 'ระยอง', brand: 'A', model: 'B', color: null, ownerName: 'สมชาย' }] }),
    );
    await submit();
    expect(document.querySelector('.modal-backdrop')).toBeNull();
    expect(container.querySelector('.ci-form-error')?.textContent).toContain('บันทึกไม่สำเร็จ');
    expect(container.textContent).not.toContain('สมชาย');
  });

  it('a plate lookup that answers vehicle_ambiguous asks for the province instead of prefilling', async () => {
    apiGet.mockImplementation(() => refused({
      error: 'vehicle_ambiguous', message: 'x',
      candidates: [{ id: V1, province: 'ระยอง', brand: 'HONDA', model: 'CITY', color: null }],
    }));
    act(() => type(field('ทะเบียนรถ'), '1กข1234'));
    await blur(field('ทะเบียนรถ'));
    expect(container.textContent).toContain('ทะเบียนนี้มีหลายจังหวัดในระบบ');
    expect(field('ยี่ห้อ').value).toBe('');
  });
});

describe('a request cancelled by logout / a change of user is silent', () => {
  it('control: a generic failure of the save DOES show the form error', async () => {
    await fillMatched();
    apiPost.mockRejectedValueOnce(new Error('boom'));
    await submit();
    expect(container.querySelector('.ci-form-error')).not.toBeNull();
  });

  it('a cancelled save shows no error and does not report the job as created', async () => {
    await fillMatched();
    apiPost.mockRejectedValueOnce(new SessionCancelledError());
    await submit();
    expect(container.querySelector('.ci-form-error')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('a cancelled photo upload is not marked failed or needs-auth', async () => {
    await fillMatched();
    apiUpload.mockRejectedValue(new SessionCancelledError());
    const input = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]')).find((i) => i.multiple)!;
    const files = [new File([new Uint8Array([0xff, 0xd8, 0xff])], 'a.jpg', { type: 'image/jpeg' })];
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 0)); });
    expect(apiUpload).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.ci-photo-session')).toBeNull();
    expect(container.textContent).not.toContain('อัปโหลดไม่สำเร็จ');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
