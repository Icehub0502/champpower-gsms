import { useId, useState } from 'react';
import { CameraScanButton } from './CameraScan';
import { Icon } from './Icon';

interface ScanInputProps {
  /** Called with the trimmed code when Enter is pressed (a USB / Bluetooth scanner sends Enter after the code). */
  onCode: (code: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Text under the box: what happened to the last scan. */
  hint?: string | null;
  hintIsError?: boolean;
}

/**
 * The box a shelf scanner types into. A hand-held scanner is a keyboard: it types the QR's
 * text (skus.code) and presses Enter. So this is an ordinary input that fires on Enter and
 * clears itself, ready for the next scan — and a person with no scanner types the code.
 * The camera button only appears where the browser can read QR by itself.
 */
export function ScanInput({ onCode, label = 'สแกน / พิมพ์รหัสอะไหล่', placeholder = 'ยิงสแกนเนอร์ หรือพิมพ์รหัสแล้วกด Enter', disabled, autoFocus, hint, hintIsError }: ScanInputProps) {
  const [text, setText] = useState('');
  const id = useId();
  function fire(raw: string) {
    const code = raw.trim();
    if (!code) return;
    setText('');
    onCode(code);
  }
  return (
    <div className="st-scan">
      <label className="field ci-field st-scan-field" htmlFor={id}>
        <span className="ci-field-label">{label}</span>
        <span className="st-scan-row">
          <Icon name="search" size={16} />
          <input
            id={id}
            value={text}
            disabled={disabled}
            autoFocus={autoFocus}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); fire(text); }
            }}
          />
        </span>
        {hint && <span className={hintIsError ? 'ci-field-error' : 'qt-line-sub'} role="status">{hint}</span>}
      </label>
      <CameraScanButton onCode={fire} disabled={disabled} />
    </div>
  );
}
