'use client';
// SCR-011 주문·결제의 움직이는 부분: 필수 동의 체크(③④) ↔ 결제 버튼(휴대폰·태블릿 아래 띠, 데스크톱 오른쪽 패널),
// 홀드 만료 대화상자. 결제 버튼은 필수 동의가 빠지면 aria-disabled + 보이는 이유 글(버튼 앞, aria-describedby)이다.
// 결제창은 붙이지 않는다: [결제하기]가 켜져 있으면 결제창에서 돌아온 것처럼 결제 복귀 화면(/checkout/return)으로 간다.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { Dialog } from '@peaket/ds/Dialog';
import type { PayMode } from '../model/view';

type ConsentKey = 'thirdParty' | 'terms';
interface ConsentValue {
  checked: Record<ConsentKey, boolean>;
  set: (key: ConsentKey, value: boolean) => void;
}

const ConsentContext = createContext<ConsentValue | null>(null);

function useConsent(): ConsentValue {
  const ctx = useContext(ConsentContext);
  if (!ctx) throw new Error('CheckoutConsentProvider 안에서만 쓴다');
  return ctx;
}

/** 필수 동의 두 개의 체크 상태를 본문(체크 칸)과 결제 버튼(아래 띠·오른쪽 패널)이 함께 본다 */
export function CheckoutConsentProvider({ initialAgreed, children }: { initialAgreed: boolean; children: ReactNode }) {
  const [checked, setChecked] = useState<Record<ConsentKey, boolean>>({ thirdParty: initialAgreed, terms: initialAgreed });
  return (
    <ConsentContext.Provider value={{ checked, set: (key, value) => setChecked((prev) => ({ ...prev, [key]: value })) }}>
      {children}
    </ConsentContext.Provider>
  );
}

/** 필수 동의 체크 줄(.check-row + .cb) */
export function ConsentCheck({ id, which, children }: { id: string; which: ConsentKey; children: ReactNode }) {
  const { checked, set } = useConsent();
  return (
    <label className="check-row" htmlFor={id}>
      <input className="cb" id={id} type="checkbox" checked={checked[which]} onChange={(e) => set(which, e.target.checked)} />
      {children}
    </label>
  );
}

const PAY_NOTE = '결제 접수 후 확정까지 몇 초가 걸립니다. 좌석이 먼저 확정되지 않으면 결제되지 않습니다';

interface Reason {
  text: string;
  tone?: 'danger';
  role?: 'status' | 'alert';
}

function reasonOf(mode: PayMode, consentOk: boolean): Reason | null {
  switch (mode) {
    case 'consent':
      return consentOk ? null : { text: '필수 동의가 필요합니다' };
    case 'sale-paused':
      return { text: '판매가 잠시 멈췄습니다. 고른 좌석은 홀드 시간 동안 유지됩니다', tone: 'danger' };
    case 'pay-paused':
      return { text: '결제가 잠시 멈췄습니다. 홀드 시간을 늘려 두었습니다', role: 'status' };
    case 'exceeded':
      return {
        text: '이 주문으로는 더 결제할 수 없습니다. 홀드 시간이 끝나면 좌석이 풀립니다. 요금은 청구되지 않았습니다',
        tone: 'danger',
        role: 'alert',
      };
    case 'expired':
      return { text: '홀드 시간이 끝났습니다' };
    default:
      return null;
  }
}

export interface PayActionProps {
  /** bar: 휴대폰·태블릿 아래 고정 띠(lg에서 숨김) · panel: 데스크톱 오른쪽 주문 요약 안 */
  layout: 'bar' | 'panel';
  mode: PayMode;
  /** '₩308,000' */
  amountText: string;
  /** 홀드 남은 시간 '5:12'와 낭독 이름 */
  holdText: string;
  holdAria: string;
  /** 결제창 복귀 화면(결제창을 흉내 낸다) */
  returnHref: string;
}

export function PayAction({ layout, mode, amountText, holdText, holdAria, returnHref }: PayActionProps) {
  const router = useRouter();
  const { checked } = useConsent();
  const reason = reasonOf(mode, checked.thirdParty && checked.terms);
  const reasonId = `pay-why-${layout}`;
  const timerTone = mode === 'pay-paused' ? 'is-paused' : mode === 'expired' ? 'is-expired' : '';
  const timer = (
    <span
      className={`timer ${timerTone}`.trim()}
      {...(layout === 'panel'
        ? { role: 'timer', 'aria-label': mode === 'expired' ? '홀드 시간 끝남' : mode === 'pay-paused' ? `${holdAria}, 멈춤` : holdAria }
        : { 'aria-hidden': true })}
    >
      <i className={`ic ${mode === 'pay-paused' ? 'ic-pause' : 'ic-clock'}`} aria-hidden="true" />
      {mode === 'expired' ? '만료' : holdText}
    </span>
  );
  const reasonEl = reason ? (
    <p className={`t-sm fw-b${reason.tone === 'danger' ? ' tx-danger' : ''}`} id={reasonId} role={reason.role}>
      {reason.text}
    </p>
  ) : null;
  const button =
    mode === 'no-id' ? (
      // 본인확인 정보를 잃은 경우: 이 화면 위에 기관 창(SCR-006)을 연다. 창은 데이터 연결 단계에서 붙인다
      <button className={`btn btn-primary btn-lg ${layout === 'panel' ? 'btn-block' : 'grow md:grow-0'}`} type="button">
        <i className="ic ic-phone" aria-hidden="true" />
        휴대폰 본인확인
      </button>
    ) : (
      <button
        className={`btn btn-primary btn-lg ${layout === 'panel' ? 'btn-block' : 'grow md:grow-0'}`}
        type="button"
        aria-disabled={reason ? true : undefined}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => {
          if (!reason) router.push(returnHref);
        }}
      >
        {amountText} 결제하기
      </button>
    );

  if (layout === 'panel') {
    return (
      <div className="col" style={{ gap: 12 }}>
        <div className="row between">
          <span className="t-sm fw-b">홀드 남은 시간</span>
          {timer}
        </div>
        <p className="t-xs muted">{PAY_NOTE}</p>
        {reasonEl}
        {button}
      </div>
    );
  }
  return (
    <div className="bottom-bar sticky bottom-0 z-10 md:px-6 md:pt-3.5 md:pb-[22px] lg:hidden">
      <div className="flex w-full flex-col gap-2 md:mx-auto md:max-w-[600px] md:flex-row md:items-center md:gap-4">
        <div className="col gap-2 md:grow md:gap-1">
          <p className="t-xs muted">{PAY_NOTE}</p>
          {reasonEl}
        </div>
        <div className="row gap-2 md:gap-4">
          {timer}
          {button}
        </div>
      </div>
    </div>
  );
}

/** 홀드 만료(결제창 열기 전): 휴대폰은 아래 시트, 태블릿·데스크톱은 가운데 대화상자 */
export function HoldExpiredDialog({ seatsHref }: { seatsHref: string }) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      layout="auto"
      icon="clock"
      title="홀드 시간이 끝났습니다"
      description="요금은 청구되지 않습니다"
      actions={
        <Link className="btn btn-primary btn-lg w-full md:w-auto" href={seatsHref}>
          좌석 다시 고르기
        </Link>
      }
    />
  );
}
