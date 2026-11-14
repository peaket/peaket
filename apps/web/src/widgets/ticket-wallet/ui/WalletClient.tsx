'use client';
// SCR-013 마이 티켓의 작은 상호작용 부품(복사·상태로 이동하는 버튼·토스트 버튼·부스 재발급 대조 동의·결제자에게 돌려주기).
// 퍼블리싱 단계라 서버 호출 없이, 흐름의 다음 상태(?state=)로 옮기거나 토스트로 결과를 보인다(ADR-0170).
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type ComponentType, type ReactNode } from 'react';
import { WebShellModal } from '@peaket/ds/WebShell';
import type { DeviceQrProps, DeviceQrSnapshot } from '@/features/wallet-device-key/ui/DeviceQr';
import type { OfflineBannerProps } from '@/features/wallet-device-key/ui/OfflineBanner';
import { useToast } from '@/shared/ui/toast';

// 월렛의 무거운 클라이언트 조각(QR·오프라인 배너)을 첫 화면 번들에서 뺀다(R-562).
// next/dynamic의 런타임을 첫 묶음에 넣지 않으려고 import()와 상태만 쓰고, 마운트 뒤 별도 덩어리를 받는다.
// 첫 HTML에는 QR 자리(400px)와 같은 모양의 등록 안내를 그려 LCP를 앞당기고 layout shift를 막는다.
function useLazyComponent<P>(load: () => Promise<ComponentType<P>>): ComponentType<P> | null {
  const [Component, setComponent] = useState<ComponentType<P> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void load()
      .then((loaded) => {
        if (!cancelled) setComponent(() => loaded);
      })
      .catch(() => {
        // 청크를 받지 못하면 화면을 막지 않는다. 다음 방문에서 다시 시도한다.
      });
    return () => {
      cancelled = true;
    };
  }, [load]);
  return Component;
}

const loadDeviceQr = () => import('@/features/wallet-device-key/ui/DeviceQr').then((m) => m.DeviceQr);
const loadOfflineBanner = () => import('@/features/wallet-device-key/ui/OfflineBanner').then((m) => m.OfflineBanner);

export function DeviceQrLazy({ fallback, ...props }: DeviceQrProps & { fallback?: ReactNode }) {
  const Component = useLazyComponent(loadDeviceQr);
  if (!Component) return <>{fallback}</>;
  return <Component {...props} />;
}

export function OfflineBannerLazy(props: OfflineBannerProps) {
  const Component = useLazyComponent(loadOfflineBanner);
  if (!Component) return <div style={{ height: 40 }} aria-hidden="true" />;
  return <Component {...props} />;
}

export type { DeviceQrProps, DeviceQrSnapshot, OfflineBannerProps };

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 예매번호 옆 복사 아이콘 버튼(icon-btn-sm) */
export function CopyNoButton({ text, label }: { text: string; label: string }) {
  const toast = useToast();
  return (
    <button
      className="icon-btn icon-btn-sm"
      type="button"
      aria-label={label}
      onClick={async () => toast((await copyText(text)) ? '예매번호를 복사했습니다' : '복사하지 못했습니다', 'ic-copy')}
    >
      <i className="ic ic-copy" aria-hidden="true" />
    </button>
  );
}

/** 누르면 다음 화면·상태로 옮기는 버튼(입장용 등록 → QR 펼침 등). 보드가 <button>으로 그린 행동 */
export function GoButton({
  href,
  className,
  label,
  describedBy,
  children,
}: {
  href: string;
  className: string;
  label?: string;
  describedBy?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <button className={className} type="button" aria-label={label} aria-describedby={describedBy} onClick={() => router.push(href, { scroll: false })}>
      {children}
    </button>
  );
}

/** 누르면 토스트 한 줄만 띄우는 버튼(요청 철회·지금 동기화 — 서버 연결 단계에서 실제 호출로 바뀐다) */
export function ToastButton({
  message,
  className,
  label,
  children,
}: {
  message: string;
  className: string;
  label?: string;
  children: ReactNode;
}) {
  const toast = useToast();
  return (
    <button className={className} type="button" aria-label={label} onClick={() => toast(message)}>
      {children}
    </button>
  );
}

/**
 * 결제자에게 돌려주기(d5 §5.13 받은 티켓 행): 확인 대화상자 "돌려주면 이 휴대폰의 입장 키가 지워집니다" → (CMP-064 재인증) → 돌려주기.
 * 추천안: 재인증 창은 account 담당 부품이라 여기서는 확인 대화상자까지 그리고, [돌려주기]는 토스트로 결과를 보인다.
 */
export function ReturnToPayerButton({
  seat,
  className,
  describedBy,
  children,
}: {
  seat: string;
  className: string;
  describedBy?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const descId = `${useId()}-desc`;
  return (
    <>
      <button
        className={className}
        type="button"
        aria-label={`${seat} 결제자에게 돌려주기`}
        aria-describedby={describedBy}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      <WebShellModal open={open} onClose={() => setOpen(false)} title="돌려주면 이 휴대폰의 입장 키가 지워집니다" describedBy={descId} icon={<i className="ic ic-undo" aria-hidden="true" />} iconTone="warning">
        <p className="t-sm" id={descId}>
          {seat} · 돌려주기 전에 카카오로 다시 로그인하며, 입장이 시작되면 돌려줄 수 없습니다.
        </p>
        <div className="col gap-2 md:flex-row-reverse md:flex-wrap md:items-center md:justify-start">
          <button
            className="btn btn-primary btn-lg btn-block md:inline-flex md:w-auto md:min-h-10 md:px-4 md:text-sm md:leading-[19px] md:rounded-(--r-md)"
            type="button"
            onClick={() => {
              setOpen(false);
              toast('결제한 분에게 돌려주었습니다');
            }}
          >
            돌려주기
          </button>
          <button
            className="btn btn-ghost btn-block md:inline-flex md:w-auto md:min-h-10 md:px-4 md:text-sm md:leading-[19px] md:rounded-(--r-md)"
            type="button"
            onClick={() => setOpen(false)}
          >
            닫기
          </button>
        </div>
      </WebShellModal>
    </>
  );
}

/**
 * 부스 재발급 1/3단계: 본인확인 결과 대조 동의(d5 §5.13 저장소 유실·입장 시작 뒤 → 대조 목적 동의 → SCR-006 → 부스 코드).
 * 휴대폰은 아래 시트(보드 m), 태블릿·데스크톱은 가운데 대화상자(보드 t·d, 최대 폭 520). 동의에 체크해야 [동의하고 휴대폰 본인확인]이 눌린다.
 * 퍼블리싱 단계라 본인확인 창(SCR-006) 없이 다음 단계인 부스 코드 상태로 옮긴다.
 */
export function BoothReissue({
  seat,
  showButton,
  initialOpen,
  nextHref,
}: {
  seat: string;
  showButton: boolean;
  initialOpen: boolean;
  nextHref: string;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [agreed, setAgreed] = useState(false);
  const router = useRouter();
  const base = useId();
  const descId = `${base}-d`;
  const whyId = `${base}-why`;
  const agreeId = `${base}-agree`;
  return (
    <>
      {showButton ? (
        <button className="btn btn-secondary btn-lg btn-block" type="button" aria-label={`${seat} 부스 재발급 요청`} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          부스 재발급 요청
        </button>
      ) : null}
      <WebShellModal
        open={open}
        onClose={() => setOpen(false)}
        maxWidth={520}
        scroll
        describedBy={descId}
        eyebrow={
          <span className="eyebrow">
            부스 재발급 1/3단계<span className="hidden md:inline"> · {seat}</span>
          </span>
        }
        title="본인확인 결과 대조 동의"
      >
        <p className="t-sm" id={descId}>
          이 티켓을 가진 분과 같은 분인지 대조합니다. 대조 결과만 남기고 연계정보는 버립니다
        </p>
        <dl className="card-flat col" style={{ gap: 8, padding: '14px 16px' }}>
          {CONSENT_ROWS.map((r) => (
            <div key={r.dt} className="col" style={{ gap: 2 }}>
              <dt className="t-xs fw-b muted">{r.dt}</dt>
              <dd className="t-sm">{r.dd}</dd>
            </div>
          ))}
        </dl>
        <label className="check-row" htmlFor={agreeId}>
          <input className="cb" id={agreeId} type="checkbox" aria-describedby={whyId} checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          대조 목적에 동의합니다 (필수)
        </label>
        {agreed ? null : (
          <p className="hint" id={whyId}>
            동의해야 휴대폰 본인확인을 시작할 수 있습니다
          </p>
        )}
        <button
          className="btn btn-primary btn-lg btn-block"
          type="button"
          aria-disabled={agreed ? undefined : true}
          aria-describedby={agreed ? undefined : whyId}
          onClick={() => {
            if (!agreed) return;
            setOpen(false);
            router.push(nextHref, { scroll: false });
          }}
        >
          동의하고 휴대폰 본인확인
        </button>
        <button className="btn btn-ghost btn-block" type="button" onClick={() => setOpen(false)}>
          닫기
        </button>
      </WebShellModal>
    </>
  );
}

const CONSENT_ROWS: readonly { dt: string; dd: string }[] = [
  { dt: '목적', dd: '입장이 시작된 뒤 이 티켓을 다시 받으려는 분이 티켓을 가진 계정의 본인인지 대조합니다' },
  {
    dt: '항목',
    dd: '휴대폰 본인확인 결과의 연계정보(대조한 뒤 바로 버립니다), 대조 결과(일치 여부)와 요청 일시. 이름·생년월일 등 다른 본인확인 결과는 받는 즉시 버립니다',
  },
  { dt: '보유 기간', dd: '연계정보는 저장하지 않습니다. 대조 결과는 공연(회차)이 끝나고 1년까지' },
  {
    dt: '거부권과 불이익',
    dd: '동의를 거부할 수 있습니다. 동의하지 않으면 부스에서 티켓을 다시 받을 수 없습니다. 입장 방법은 현장 직원에게 문의해 주세요',
  },
];
