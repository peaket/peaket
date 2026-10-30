'use client';
// SCR-010의 작은 상호작용 부품(클라이언트). 서버 페이지는 주소 문자열만 넘긴다.
// - NavButton: 보드의 <button> 모양을 지키며 다음 화면이나 같은 화면의 다른 상태(퍼블리싱 흉내)로 옮긴다. aria-disabled면 움직이지 않는다.
// - GradeChips: 등급으로 좁히기(aria-pressed 하나 고르기). 지금은 지도 모양을 바꾸지 않는다(근사).
// - QtyStepper: 수동 선택의 매수(키트 .stepper-num). 한도에서 + 비활성.
// - IdleDialog: 무활동 경고(role=alertdialog, 휴대폰 시트 · 태블릿 위 가운데 대화상자).
import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@peaket/ds/Dialog';

export interface NavButtonProps {
  href: string;
  className: string;
  children: ReactNode;
  /** 이유 있는 비활성(aria-disabled + 이유 글 id) */
  disabled?: boolean;
  describedBy?: string;
  label?: string;
}

export function NavButton({ href, className, children, disabled = false, describedBy, label }: NavButtonProps) {
  const router = useRouter();
  return (
    <button
      className={className}
      type="button"
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      aria-label={label}
      onClick={() => {
        if (!disabled) router.push(href, { scroll: false });
      }}
    >
      {children}
    </button>
  );
}

export function GradeChips({ grades }: { grades: readonly string[] }) {
  const [value, setValue] = useState('전체');
  return (
    <div className="row" style={{ gap: 6 }} role="group" aria-label="등급으로 좁히기">
      {['전체', ...grades].map((g) => (
        <button
          key={g}
          className={value === g ? 'chip chip-sm is-selected' : 'chip chip-sm'}
          type="button"
          aria-pressed={value === g}
          onClick={() => setValue(g)}
        >
          {g}
        </button>
      ))}
    </div>
  );
}

export function QtyStepper({ initial, max, labelledBy, describedBy }: { initial: number; max: number; labelledBy: string; describedBy: string }) {
  const [n, setN] = useState(initial);
  const atMax = n >= max;
  return (
    <div className="stepper-num" role="group" aria-labelledby={labelledBy} aria-describedby={describedBy}>
      <button type="button" aria-label="매수 줄이기" disabled={n <= 1} className={n <= 1 ? 'tx-disabled' : undefined} onClick={() => setN((v) => Math.max(1, v - 1))}>
        <i className="ic ic-minus ic-16" aria-hidden="true" />
      </button>
      <output aria-live="polite">{n}</output>
      <button type="button" aria-label="매수 늘리기" disabled={atMax} className={atMax ? 'tx-disabled' : undefined} onClick={() => setN((v) => Math.min(max, v + 1))}>
        <i className="ic ic-plus ic-16" aria-hidden="true" />
      </button>
    </div>
  );
}

export function IdleDialog() {
  const [open, setOpen] = useState(true);
  const continueRef = useRef<HTMLButtonElement>(null);
  // '계속하기'는 구매 세션 무활동 연장을 요청한다(d5 §5.10). 퍼블리싱에서는 닫기만 한다.
  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      role="alertdialog"
      layout="auto"
      icon="clock"
      iconTone="warning"
      title="계속 예매하시겠어요?"
      describedBy="idle-d"
      initialFocus={continueRef}
      dismissible={false}
      actions={
        <button ref={continueRef} className="btn btn-primary btn-lg max-md:w-full" type="button" onClick={() => setOpen(false)}>
          계속하기
        </button>
      }
    >
      <p className="t-md" id="idle-d">
        1분 뒤 예매가 끝납니다
      </p>
    </Dialog>
  );
}
