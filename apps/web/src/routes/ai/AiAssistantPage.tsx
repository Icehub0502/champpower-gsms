import { useState, type FormEvent } from 'react';
import type { ShopConfig } from '@champpower/domain';
import { api, ApiError } from '../../lib/api/client';
import { useDocument } from '../../hooks/useDocument';

const SUGGESTED_PROMPTS = [
  'สรุปรถที่ยังรออนุมัติวันนี้',
  'มีรถรุ่นไหนใช้แร็คพวงมาลัย RK-TO-118 บ้าง',
  'สรุปรายได้สัปดาห์นี้เทียบสัปดาห์ก่อน',
  'หางานของช่างท็อปที่ยังไม่เสร็จ',
];

interface ChatMessage {
  id: string;
  role: 'user' | 'bot' | 'error';
  text: string;
}

/** POST /api/ai/summarize really exists (apps/api/src/routes/ai.ts) and calls out to
 * Claude/Gemini server-side using CLAUDE_API_KEY/GEMINI_API_KEY. Those keys are blank
 * in local dev, so the endpoint returns a real 502 with a friendly message — shown
 * here as an "error" chat bubble instead of a silent failure or a fake canned answer,
 * per the wiring spec. `model` defaults to ShopConfig.settings.aiModel when set. */
export function AiAssistantPage() {
  const config = useDocument<ShopConfig>('/api/config');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const model = config.data?.settings.aiModel === 'gemini' ? 'gemini' : 'claude';

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', text: trimmed };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setSending(true);
    try {
      const res = await api.post<{ text: string }>('/api/ai/summarize', { prompt: trimmed, model });
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'bot', text: res.text }]);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'เรียกใช้งาน AI ไม่สำเร็จ';
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'error', text: message }]);
    } finally {
      setSending(false);
    }
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
          <div className="ai-prompts">
            {SUGGESTED_PROMPTS.map((p) => (
              <button type="button" key={p} className="ai-prompt-tile" onClick={() => ask(p)} disabled={sending}>
                {p}
              </button>
            ))}
          </div>
        ) : (
          <div className="ai-chat-log" role="log" aria-live="polite">
            {messages.map((m) => (
              <div key={m.id} className={`ai-msg ${m.role === 'error' ? 'bot ai-msg-error' : m.role}`}>
                {m.text}
              </div>
            ))}
            {sending && (
              <div className="ai-msg bot" aria-live="polite">
                กำลังคิดคำตอบ...
              </div>
            )}
          </div>
        )}

        <form className="ai-input-row" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="ai-question">พิมพ์คำถาม</label>
          <input
            id="ai-question"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="พิมพ์คำถามเกี่ยวกับข้อมูลในระบบ…"
            disabled={sending}
          />
          <button type="submit" className="btn" disabled={sending || !input.trim()}>
            ส่ง
          </button>
        </form>
        <p className="ai-disclaimer">AI อาจตอบคลาดเคลื่อน ควรตรวจสอบข้อมูลสำคัญก่อนใช้งาน</p>
      </div>
    </div>
  );
}
