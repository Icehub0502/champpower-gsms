import { useState, type FormEvent } from 'react';

// TODO: replace the canned response below with a real backend call once an AI
// assistant endpoint exists (this page is UI-only per the redesign scope).
const SUGGESTED_PROMPTS = [
  'สรุปรถที่ยังรออนุมัติวันนี้',
  'มีรถรุ่นไหนใช้แร็คพวงมาลัย RK-TO-118 บ้าง',
  'สรุปรายได้สัปดาห์นี้เทียบสัปดาห์ก่อน',
  'หางานของช่างท็อปที่ยังไม่เสร็จ',
];

const CANNED_ANSWER = `พบ 3 คันที่ยังรออนุมัติวันนี้:
• SV-02681 Toyota Camry — แร็คพวงมาลัย ฿6,500 (รออนุมัติ 2 ชม.)
• SV-02658 BMW E90 — ปีกนกหน้า ฿9,800 (รออนุมัติ 5 ชม.)
• SV-02631 Honda Accord — โช้คอัพหน้า ฿8,400 (รออนุมัติ 1 วัน)`;

interface ChatMessage {
  id: string;
  role: 'user' | 'bot';
  text: string;
}

export function AiAssistantPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');

  function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', text: trimmed },
      { id: crypto.randomUUID(), role: 'bot', text: CANNED_ANSWER },
    ]);
    setInput('');
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    ask(input);
  }

  return (
    <div className="page">
      <h1>AI ผู้ช่วย</h1>
      <p className="page-sub">ถามคำถามเกี่ยวกับงาน อะไหล่ หรือรายได้ในระบบด้วยภาษาพูด</p>

      <div className="ai-card">
        <div className="ai-title-row">
          <h2 style={{ margin: 0, fontSize: 18 }}>POWER AI</h2>
          <span className="ai-badge">Beta</span>
        </div>

        {messages.length === 0 ? (
          <>
            <div className="ai-prompts">
              {SUGGESTED_PROMPTS.map((p) => (
                <button type="button" key={p} className="ai-prompt-tile" onClick={() => ask(p)}>
                  {p}
                </button>
              ))}
            </div>
            <div>
              <p className="field-label" style={{ marginBottom: 6 }}>ตัวอย่างคำตอบ</p>
              <div className="ai-answer">
                <b>พบ 3 คันที่ยังรออนุมัติวันนี้</b>
                <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                  <li>SV-02681 Toyota Camry — แร็คพวงมาลัย ฿6,500</li>
                  <li>SV-02658 BMW E90 — ปีกนกหน้า ฿9,800</li>
                  <li>SV-02631 Honda Accord — โช้คอัพหน้า ฿8,400</li>
                </ul>
              </div>
            </div>
          </>
        ) : (
          <div className="ai-chat-log" role="log" aria-live="polite">
            {messages.map((m) => (
              <div key={m.id} className={`ai-msg ${m.role}`}>
                {m.text}
              </div>
            ))}
          </div>
        )}

        <form className="ai-input-row" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="ai-question">พิมพ์คำถาม</label>
          <input
            id="ai-question"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="พิมพ์คำถามเกี่ยวกับข้อมูลในระบบ…"
          />
          <button type="submit" className="btn">ส่ง</button>
        </form>
        <p className="ai-disclaimer">AI อาจตอบคลาดเคลื่อน ควรตรวจสอบข้อมูลสำคัญก่อนใช้งาน</p>
      </div>
    </div>
  );
}
