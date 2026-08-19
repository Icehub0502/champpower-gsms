import { useRef, useState } from 'react';

interface SignaturePadProps {
  label: string;
  value?: string;
  onSave: (dataUrl: string) => void;
}

export function SignaturePad({ label, value, onSave }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * canvas.height) / rect.height,
    };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    last.current = point(e);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    e.preventDefault();
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const p = point(e);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#222831';
    ctx.beginPath();
    ctx.moveTo(last.current!.x, last.current!.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    setDirty(true);
  }

  function stop() {
    drawing.current = false;
  }

  function clear() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    setDirty(false);
  }

  function save() {
    const canvas = canvasRef.current;
    if (!canvas || !dirty) return;
    onSave(canvas.toDataURL('image/png'));
    setEditing(false);
    setDirty(false);
  }

  if (!editing) {
    return (
      <div className="sig-block">
        <div className="sig-label">{label}</div>
        {value ? (
          <img className="sig-preview" src={value} alt={label} />
        ) : (
          <div className="sig-empty">ยังไม่ได้เซ็น</div>
        )}
        <button className="btn secondary small" onClick={() => setEditing(true)}>
          {value ? 'เซ็นใหม่' : 'เซ็นชื่อ'}
        </button>
      </div>
    );
  }

  return (
    <div className="sig-block">
      <div className="sig-label">{label}</div>
      <canvas
        ref={canvasRef}
        width={480}
        height={180}
        className="sig-canvas"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={stop}
        onPointerLeave={stop}
      />
      <div className="row-flex">
        <button type="button" className="btn secondary small" onClick={clear}>
          ล้าง
        </button>
        <button type="button" className="btn small" disabled={!dirty} onClick={save}>
          บันทึกลายเซ็น
        </button>
        <button type="button" className="btn secondary small" onClick={() => setEditing(false)}>
          ยกเลิก
        </button>
      </div>
    </div>
  );
}
