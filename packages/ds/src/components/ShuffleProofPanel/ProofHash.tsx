'use client';
// CMP-049의 해시·주소 한 줄과 [복사] 아이콘 버튼(키트 .hash + .icon-btn.icon-btn-sm.icon-btn-outline).
// 복사 버튼에 분명한 이름을 단다('시드 해시 복사', d2 §2 CMP-049·d3 SCR-019). 복사하면 아이콘이 잠시 체크로 바뀌고
// 화면 밖 상태 글("시드 해시를 복사했습니다")을 한 번 읽는다. 복사하지 못하면 "복사하지 못했습니다. 값을 길게 눌러 고르세요"를 읽는다.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface ProofHashProps {
  /** 이름표('시드 해시(커밋)') */
  label: ReactNode;
  value: string;
  /** 복사 버튼 이름('시드 해시 복사'). 없으면 버튼 없이 값만 */
  copyLabel?: string;
  /** 복사 뒤 읽을 글. 없으면 '{copyLabel 앞말}를 복사했습니다' */
  copiedText?: string;
}

export function ProofHash({ label, value, copyLabel, copiedText }: ProofHashProps) {
  const [status, setStatus] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setStatus('done');
    } catch {
      setStatus('failed');
    }
    timer.current = setTimeout(() => setStatus('idle'), 2000);
  }

  const done = copiedText ?? (copyLabel ? `${copyLabel.replace(/ 복사$/, '')}를 복사했습니다` : '복사했습니다');
  return (
    <div className="col" style={{ gap: 4 }}>
      <span className="t-xs fw-b muted">{label}</span>
      {copyLabel ? (
        <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
          <code className="hash grow">{value}</code>
          <button className="icon-btn icon-btn-sm icon-btn-outline" type="button" aria-label={copyLabel} onClick={copy}>
            <i className={`ic ${status === 'done' ? 'ic-check' : 'ic-copy'}`} aria-hidden="true" />
          </button>
          <span className="sr-only" role="status">
            {status === 'done' ? done : status === 'failed' ? '복사하지 못했습니다. 값을 길게 눌러 고르세요' : ''}
          </span>
        </div>
      ) : (
        <code className="hash">{value}</code>
      )}
    </div>
  );
}
