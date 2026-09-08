import { useEffect, useMemo, useState } from 'react';
import {
  BRAND_OPTIONS,
  DEFAULT_COMPLAINTS,
  genQueueNo,
  todaysJobs,
  type Complaint,
  type Customer,
  type Job,
  type Vehicle,
  type VehicleModel,
} from '@champpower/domain';
import { api } from '../../lib/api/client';
import { useCollection } from '../../hooks/useCollection';
import { compressImage } from '../../lib/compressImage';
import { Icon } from '../../components/ui/Icon';

interface CheckInPageProps {
  onCreated: (jobId: string) => void;
}

export function CheckInPage({ onCreated }: CheckInPageProps) {
  const vehicles = useCollection<Vehicle>('/api/vehicles');
  const customers = useCollection<Customer>('/api/customers');
  const jobs = useCollection<Job>('/api/jobs?includeDeleted=1');
  const models = useCollection<VehicleModel>('/api/models');

  const [plate, setPlate] = useState('');
  const [province, setProvince] = useState('');
  const [mileage, setMileage] = useState('');
  const [queueNo, setQueueNo] = useState('');
  const [queueTouched, setQueueTouched] = useState(false);
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [color, setColor] = useState('');
  const [year, setYear] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [customComplaint, setCustomComplaint] = useState('');
  const [customComplaints, setCustomComplaints] = useState<string[]>([]);
  const [carPhoto, setCarPhoto] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const plateUpper = plate.trim().toUpperCase();
  const matchedVehicle = useMemo(
    () => vehicles.rows.find((v) => (v.plate || '').trim().toUpperCase() === plateUpper && plateUpper),
    [vehicles.rows, plateUpper],
  );
  const matchedCustomer = matchedVehicle
    ? customers.rows.find((c) => c.id === matchedVehicle.customerId)
    : undefined;

  // Auto-fills the next sequential queue number for today as soon as the job list has
  // loaded — staff can still overwrite it by hand, which stops this from re-suggesting.
  useEffect(() => {
    if (queueTouched || jobs.loading) return;
    setQueueNo(genQueueNo(todaysJobs(jobs.rows)));
  }, [jobs.loading, jobs.rows, queueTouched]);

  const catalogLabel = (m: VehicleModel) => `${m.brand} ${m.name}`;
  const catalogByLabel = useMemo(() => new Map(models.rows.map((m) => [catalogLabel(m), m])), [models.rows]);

  function onCatalogPick(value: string) {
    setCatalogQuery(value);
    const picked = catalogByLabel.get(value);
    if (picked) {
      setBrand(picked.brand);
      setModel(picked.name);
    }
  }

  function toggleComplaint(text: string) {
    setChecked((prev) => (prev.includes(text) ? prev.filter((t) => t !== text) : [...prev, text]));
  }

  function addCustomComplaint() {
    const v = customComplaint.trim();
    if (!v) return;
    setCustomComplaints((prev) => [...prev, v]);
    setCustomComplaint('');
  }

  async function onCarPhotoPicked(file: File | undefined) {
    if (!file) return;
    setPhotoBusy(true);
    try {
      setCarPhoto(await compressImage(file));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function handleSubmit() {
    setError('');
    if (!plateUpper) {
      setError('กรุณากรอกทะเบียนรถ');
      return;
    }
    if (!mileage.trim()) {
      setError('กรุณากรอกเลขไมล์');
      return;
    }

    setSubmitting(true);
    try {
      const complaints: Complaint[] = [
        ...checked.map((text) => ({ text, custom: false })),
        ...customComplaints.map((text) => ({ text, custom: true })),
      ];

      // Job numbering (genJobNumber/genQueueNo) now runs server-side on POST /api/jobs
      // per the locked API contract — the client only still sends the (auto-suggested,
      // staff-editable) queueNo as a hint; jobNumber/id/createdAt/statusHistory are all
      // assigned by the server.
      let created: Job;
      if (matchedVehicle) {
        await api.patch(`/api/vehicles/${matchedVehicle.id}`, { mileage: mileage.trim() });
        created = await api.post<Job>('/api/jobs', {
          vehicleId: matchedVehicle.id,
          customerId: matchedVehicle.customerId,
          mileageIn: mileage.trim(),
          queueNo: queueNo.trim(),
          status: 'received',
          complaints,
          partsNeeded: [],
        });
      } else {
        if (!customerName.trim()) {
          setError('กรุณากรอกชื่อลูกค้า');
          setSubmitting(false);
          return;
        }
        created = await api.post<Job>('/api/jobs', {
          vehicle: {
            plate: plateUpper,
            province: province.trim(),
            brand: brand.trim().toUpperCase(),
            model: model.trim().toUpperCase(),
            color: color.trim(),
            year: year.trim(),
            mileage: mileage.trim(),
          },
          customer: {
            name: customerName.trim(),
            phone: customerPhone.trim(),
          },
          mileageIn: mileage.trim(),
          queueNo: queueNo.trim(),
          status: 'received',
          complaints,
          partsNeeded: [],
        });
      }

      // Car photo is captured client-side before the job exists, so it's attached via
      // the same PATCH /api/jobs/:id thumb/photoCount pair JobDetailPage's own "รูปรถ"
      // uploader uses — there's no create-time photo field on the API contract.
      if (carPhoto) {
        await api.patch<Job>(`/api/jobs/${created.id}`, { thumb: carPhoto, photoCount: 1 });
      }

      onCreated(created.id);
    } catch (err) {
      setError(`บันทึกไม่สำเร็จ: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <h1>รับรถ</h1>

      <div className="card">
        <h3>ข้อมูลใบรับรถ</h3>
        <label className="field">
          ทะเบียนรถ
          <input
            className="plate-input"
            value={plate}
            onChange={(e) => setPlate(e.target.value)}
            placeholder="1กข1234"
          />
        </label>

        {matchedVehicle ? (
          <div className="ci-match">
            พบรถที่เคยเข้ามาแล้ว: <b>{matchedVehicle.brand} {matchedVehicle.model}</b>
            {matchedCustomer && <> — ลูกค้า {matchedCustomer.name}</>}
          </div>
        ) : plateUpper ? (
          <div className="ci-nomatch">รถใหม่ — กรอกข้อมูลด้านล่าง</div>
        ) : null}

        {!matchedVehicle && (
          <div className="row-flex">
            <label className="field">
              จังหวัด
              <input value={province} onChange={(e) => setProvince(e.target.value)} />
            </label>
            <label className="field">
              เลขไมล์
              <input value={mileage} onChange={(e) => setMileage(e.target.value)} inputMode="numeric" />
            </label>
          </div>
        )}
        {matchedVehicle && (
          <label className="field">
            เลขไมล์
            <input value={mileage} onChange={(e) => setMileage(e.target.value)} inputMode="numeric" />
          </label>
        )}

        <label className="field">
          คิวที่ (รันอัตโนมัติ — แก้ไขได้ถ้าต้องการ)
          <input
            value={queueNo}
            onChange={(e) => {
              setQueueTouched(true);
              setQueueNo(e.target.value);
            }}
            inputMode="numeric"
          />
        </label>

        {!matchedVehicle && (
          <div className="row-flex">
            <label className="field">
              ชื่อลูกค้า
              <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </label>
            <label className="field">
              เบอร์โทร
              <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
            </label>
          </div>
        )}

        <h3 className="ci-photo-heading">รูปรถตอนรับ</h3>
        <label className="photo-dropzone no-print">
          {carPhoto ? (
            <>
              <img className="photo-dropzone-img" src={carPhoto} alt="รูปรถ" />
              <span className="photo-dropzone-overlay">
                <Icon name="camera" size={16} /> เปลี่ยนรูป
              </span>
            </>
          ) : (
            <span className="photo-dropzone-empty">
              <Icon name="camera" size={28} />
              แตะเพื่อถ่ายหรือแนบรูปรถ
            </span>
          )}
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => onCarPhotoPicked(e.target.files?.[0])}
          />
        </label>
        {photoBusy && <span className="page-sub">กำลังบันทึกรูป...</span>}
      </div>

      {!matchedVehicle && (
        <div className="card">
          <h3>ข้อมูลรถ</h3>
          {models.rows.length > 0 && (
            <label className="field">
              เลือกจากแคตตาล็อกรุ่นรถ (ไม่บังคับ)
              <input
                list="catalog-model-options"
                value={catalogQuery}
                onChange={(e) => onCatalogPick(e.target.value)}
                placeholder="พิมพ์ค้นหา เช่น TOYOTA VIOS"
              />
              <datalist id="catalog-model-options">
                {models.rows.map((m) => (
                  <option key={m.id} value={catalogLabel(m)} />
                ))}
              </datalist>
            </label>
          )}
          <div className="row-flex">
            <label className="field">
              ยี่ห้อ
              <input list="brand-options" value={brand} onChange={(e) => setBrand(e.target.value)} />
              <datalist id="brand-options">
                {BRAND_OPTIONS.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </label>
            <label className="field">
              รุ่น
              <input value={model} onChange={(e) => setModel(e.target.value)} />
            </label>
          </div>
          <div className="row-flex">
            <label className="field">
              สี
              <input value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
            <label className="field">
              ปีรถ
              <input value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" placeholder="เช่น 2020" />
            </label>
          </div>
        </div>
      )}

      <div className="card">
        <h3>อาการที่ลูกค้าแจ้ง</h3>
        <div className="complaint-chips complaint-chips-scroll">
          {DEFAULT_COMPLAINTS.map((c) => (
            <button
              key={c}
              type="button"
              className={`chip ${checked.includes(c) ? 'active' : ''}`}
              onClick={() => toggleComplaint(c)}
            >
              {c}
            </button>
          ))}
        </div>
        {customComplaints.map((c) => (
          <div key={c} className="chip active">
            {c}
          </div>
        ))}
        <div className="row-flex">
          <input
            value={customComplaint}
            onChange={(e) => setCustomComplaint(e.target.value)}
            placeholder="อาการอื่นๆ..."
          />
          <button type="button" className="btn" onClick={addCustomComplaint}>
            เพิ่ม
          </button>
        </div>
      </div>

      {error && <div className="login-error">{error}</div>}

      <button className="btn block" disabled={submitting} onClick={handleSubmit}>
        {submitting ? 'กำลังบันทึก...' : 'บันทึกรับรถ'}
      </button>
    </div>
  );
}
