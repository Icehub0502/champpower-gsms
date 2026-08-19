import { useMemo, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import {
  BRAND_OPTIONS,
  DEFAULT_COMPLAINTS,
  genJobNumber,
  type Complaint,
  type Customer,
  type Job,
  type Vehicle,
  type VehicleModel,
} from '@champpower/domain';
import { db } from '../../lib/firebase/client';
import { syncBoardEntry } from '../../lib/firebase/board';
import { useCollection } from '../../hooks/useCollection';

interface CheckInPageProps {
  onCreated: (jobId: string) => void;
}

export function CheckInPage({ onCreated }: CheckInPageProps) {
  const vehicles = useCollection<Vehicle>('vehicles');
  const customers = useCollection<Customer>('customers');
  const jobs = useCollection<Job>('jobs');
  const models = useCollection<VehicleModel>('models');

  const [plate, setPlate] = useState('');
  const [province, setProvince] = useState('');
  const [mileage, setMileage] = useState('');
  const [queueNo, setQueueNo] = useState('');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [color, setColor] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [customComplaint, setCustomComplaint] = useState('');
  const [customComplaints, setCustomComplaints] = useState<string[]>([]);
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
      let vehicleId: string;
      let customerId: string;

      if (matchedVehicle) {
        vehicleId = matchedVehicle.id;
        customerId = matchedVehicle.customerId;
        await updateDoc(doc(db, 'vehicles', vehicleId), { mileage: mileage.trim() });
      } else {
        if (!customerName.trim()) {
          setError('กรุณากรอกชื่อลูกค้า');
          setSubmitting(false);
          return;
        }
        const customerRef = await addDoc(collection(db, 'customers'), {
          name: customerName.trim(),
          phone: customerPhone.trim(),
        });
        customerId = customerRef.id;
        const vehicleRef = await addDoc(collection(db, 'vehicles'), {
          customerId,
          plate: plateUpper,
          province: province.trim(),
          brand: brand.trim().toUpperCase(),
          model: model.trim().toUpperCase(),
          color: color.trim(),
          mileage: mileage.trim(),
        });
        vehicleId = vehicleRef.id;
      }

      const complaints: Complaint[] = [
        ...checked.map((text) => ({ text, custom: false })),
        ...customComplaints.map((text) => ({ text, custom: true })),
      ];

      // jobNumber is sequential per day (PGyymmdd-NNN) — genJobNumber itself filters
      // existingJobs down to today's prefix, so the full jobs list can be passed as-is.
      const jobNumber = genJobNumber(jobs.rows);
      const nowIso = new Date().toISOString();

      const newJobData = {
        jobNumber,
        queueNo: queueNo.trim(),
        vehicleId,
        customerId,
        mileageIn: mileage.trim(),
        status: 'received' as const,
        complaints,
        partsNeeded: [],
        createdAt: nowIso,
        statusHistory: [{ status: 'received' as const, changedAt: nowIso }],
      };
      const jobRef = await addDoc(collection(db, 'jobs'), { ...newJobData, serverCreatedAt: serverTimestamp() });

      const vehicleForBoard =
        matchedVehicle ??
        ({
          id: vehicleId,
          customerId,
          plate: plateUpper,
          brand: brand.trim().toUpperCase(),
          model: model.trim().toUpperCase(),
          province: province.trim(),
          color: color.trim(),
        } as Vehicle);
      await syncBoardEntry({ ...newJobData, id: jobRef.id }, vehicleForBoard);

      onCreated(jobRef.id);
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

        <label className="field">
          เลขไมล์
          <input value={mileage} onChange={(e) => setMileage(e.target.value)} inputMode="numeric" />
        </label>

        <label className="field">
          คิวที่ (ไม่บังคับ)
          <input value={queueNo} onChange={(e) => setQueueNo(e.target.value)} inputMode="numeric" />
        </label>

        {!matchedVehicle && (
          <>
            <label className="field">
              ชื่อลูกค้า
              <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </label>
            <label className="field">
              เบอร์โทร
              <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
            </label>
            <label className="field">
              จังหวัด
              <input value={province} onChange={(e) => setProvince(e.target.value)} />
            </label>
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
            <label className="field">
              สี
              <input value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
          </>
        )}
      </div>

      <div className="card">
        <h3>อาการที่แจ้ง</h3>
        <div className="complaint-chips">
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
