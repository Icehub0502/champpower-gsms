import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Modal } from './Modal';

// The browser's own barcode reader (Shape Detection API). Not in TypeScript's DOM lib yet,
// so the few members used here are described locally. This is a BROWSER type, not an API one.
interface DetectedCode { rawValue: string }
interface BarcodeDetectorLike { detect(source: CanvasImageSource): Promise<DetectedCode[]> }
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

function detectorCtor(): BarcodeDetectorCtor | null {
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return typeof w.BarcodeDetector === 'function' && !!navigator.mediaDevices?.getUserMedia ? w.BarcodeDetector : null;
}

/**
 * Camera QR scanning, ONLY where the browser reads QR codes by itself (Chrome / Edge on
 * Android, most desktops). No library is pulled in for it: WO-006 §4 lists the camera as
 * "if time", and the guaranteed paths are search-and-pick and a USB/Bluetooth scanner
 * typing into a text box. Where the browser cannot (iPhone/iPad Safari today), this
 * renders nothing and the text box is the way in.
 */
export function cameraScanSupported(): boolean {
  return typeof window !== 'undefined' && detectorCtor() !== null;
}

export function CameraScanButton({ onCode, disabled, label = 'สแกนด้วยกล้อง' }: { onCode: (code: string) => void; disabled?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!cameraScanSupported()) return null;
  return (
    <>
      <button type="button" className="btn secondary st-scan-btn" disabled={disabled} onClick={() => setOpen(true)}>
        <Icon name="camera" size={16} /> {label}
      </button>
      {open && (
        <CameraScanDialog
          onClose={() => setOpen(false)}
          onCode={(c) => { setOpen(false); onCode(c); }}
        />
      )}
    </>
  );
}

function CameraScanDialog({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  // The latest callback without restarting the camera when the parent re-renders.
  const emit = useEffectEvent((code: string) => onCode(code));

  useEffect(() => {
    const Ctor = detectorCtor();
    if (!Ctor) return;
    let stream: MediaStream | null = null;
    let timer: number | null = null;
    let stopped = false;
    const detector = new Ctor({ formats: ['qr_code', 'code_128', 'ean_13'] });

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        // Closed while the permission prompt was up: let go of the camera at once.
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        await v.play();
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            const code = found.find((f) => f.rawValue.trim() !== '')?.rawValue.trim();
            if (code && !stopped) { stopped = true; emit(code); return; }
          } catch {
            // A frame that could not be read is not an error worth showing.
          }
          timer = window.setTimeout(() => void tick(), 250);
        };
        void tick();
      } catch {
        if (!stopped) setError('เปิดกล้องไม่ได้ — อนุญาตการใช้กล้องในเบราว์เซอร์ หรือปิดหน้าต่างนี้แล้วพิมพ์รหัส/ค้นหาแทน');
      }
    }
    void start();

    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <Modal title="สแกน QR บนป้ายอะไหล่" onClose={onClose}>
      <div className="st-camera">
        {error ? <p className="ci-form-error" role="alert">{error}</p> : <video ref={videoRef} className="st-camera-video" muted playsInline />}
        <p className="qt-line-sub">หันกล้องไปที่ QR บนป้ายชั้นวาง — เจอแล้วจะปิดเอง</p>
      </div>
    </Modal>
  );
}
