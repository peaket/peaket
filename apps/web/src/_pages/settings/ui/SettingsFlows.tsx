'use client';
// SCR-017 위의 흐름(보드 SCR-017 겹침 창 상태, d5 §5.17 탈퇴 단계). 휴대폰은 아래 시트, 태블릿·데스크톱은 대화상자다(WebShellModal responsive).
// - 다른 기기 로그아웃 → 재인증(CMP-064 fan-social 자리, 실패 문구 role="alert") → 목록에서 빼고 토스트 '… 에서 로그아웃했습니다'
// - ( 회원 탈퇴 › ) → 재인증 → 탈퇴 확인(CMP-054 환급 예상을 결과 버튼보다 먼저, CMP-020 fan의 결과를 적은 버튼) → 완료·미룸 화면
// - 로그아웃 확인은 셸의 대화상자(AppShell defaultOpen="logout")를 쓴다.
// 재인증 창의 '회원 탈퇴' 문구는 보드에 없어 다른 기기 로그아웃 문구를 바꿔 썼다(추천안). 퍼블리싱 단계라 실제 재인증·탈퇴 API는 붙이지 않는다.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { DeviceSessionList, type DeviceSession } from '@peaket/ds/DeviceSessionList';
import { previewHref } from '@peaket/ds/Preview';
import { Select } from '@peaket/ds/Select';
import { TextField } from '@peaket/ds/TextField';
import { WebShellModal } from '@peaket/ds/WebShell';
import { BANKS } from '@/entities/account';
import { formatWon } from '@/entities/production';
import { useToast } from '@/shared/ui/toast';
import type { WithdrawQuote } from '../model/account';
import type { SettingsOverlay } from '../model/state';

type Overlay = Exclude<SettingsOverlay, { kind: 'logout' }>;
type ReauthPurpose = { kind: 'device'; session: DeviceSession } | { kind: 'withdraw' };

interface FlowsContextValue {
  devices: readonly DeviceSession[];
  devicesLoading: boolean;
  onDeviceLogout: (s: DeviceSession) => void;
  startWithdraw: () => void;
}

const FlowsContext = createContext<FlowsContextValue>({ devices: [], devicesLoading: false, onDeviceLogout: () => {}, startWithdraw: () => {} });

export interface SettingsFlowsProps {
  /** 처음 열린 채로 그릴 창(상태 미리보기) */
  initial: Overlay | null;
  devices: readonly DeviceSession[];
  /** 이미 로그아웃해 목록에서 빠진 기기 */
  removedIds?: readonly string[];
  devicesLoading?: boolean;
  /** 들어오자마자 띄울 토스트(상태 '원격 로그아웃 완료') */
  toastOnMount?: string;
  provider: { label: string; btn: string; prov: string };
  quote: WithdrawQuote;
  dark: boolean;
  children: ReactNode;
}

export function SettingsFlows({ initial, devices, removedIds = [], devicesLoading = false, toastOnMount, provider, quote, dark, children }: SettingsFlowsProps) {
  const toast = useToast();
  const router = useRouter();
  const ids = useId();
  const [removed, setRemoved] = useState<readonly string[]>(removedIds);
  const [overlay, setOverlay] = useState<Overlay | null>(initial);
  // 미리보기 상태의 재인증 창은 '다른 기기 로그아웃' 대상(Safari · iPhone)으로 연다
  const [purpose, setPurpose] = useState<ReauthPurpose>(() => {
    const target = devices.find((d) => !d.current);
    return target ? { kind: 'device', session: target } : { kind: 'withdraw' };
  });
  const close = () => setOverlay(null);

  useEffect(() => {
    if (toastOnMount) toast(toastOnMount, 'ic-check');
    // 처음 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmReauth = () => {
    if (purpose.kind === 'device') {
      setRemoved((r) => [...r, purpose.session.id]);
      setOverlay(null);
      toast(`${purpose.session.name}에서 로그아웃했습니다`, 'ic-check');
    } else {
      setOverlay({ kind: 'withdraw', refund: 'none' });
    }
  };

  const confirmWithdraw = (refund: 'none' | 'vb-now' | 'vb-later') => {
    const next = refund === 'vb-later' ? '탈퇴 접수(미룸)' : '탈퇴 완료';
    router.push(previewHref('/my/settings', next, { theme: dark ? 'dark' : undefined }));
  };

  const ctx: FlowsContextValue = {
    devices: devices.filter((d) => !removed.includes(d.id)),
    devicesLoading,
    onDeviceLogout: (session) => {
      setPurpose({ kind: 'device', session });
      setOverlay({ kind: 'reauth', failed: false });
    },
    startWithdraw: () => {
      setPurpose({ kind: 'withdraw' });
      setOverlay({ kind: 'reauth', failed: false });
    },
  };

  const reauthWhat = purpose.kind === 'device' ? '다른 기기 로그아웃' : '회원 탈퇴';

  return (
    <FlowsContext.Provider value={ctx}>
      {children}

      <WebShellModal
        open={overlay?.kind === 'reauth'}
        onClose={close}
        title="다시 로그인하고 계속"
        icon={<i className="ic ic-shield" aria-hidden="true" />}
        iconTone="primary"
        describedBy={`${ids}-ra`}
        maxWidth={440}
      >
        {overlay?.kind === 'reauth' && overlay.failed ? (
          <div className="banner banner-danger" role="alert">
            <i className="ic ic-alert-circle" aria-hidden="true" />
            <div className="banner-body">다시 로그인하지 못했습니다. 다시 시도해 주세요</div>
          </div>
        ) : null}
        <p className="t-sm" id={`${ids}-ra`}>
          {reauthWhat}
          {purpose.kind === 'device' ? '은 되돌리기 어려운' : '는 되돌릴 수 없는'} 작업이라 로그인한 분이 맞는지 한 번 더 확인합니다. 지금 로그인한 {provider.label} 계정으로 다시
          로그인해 주세요.
        </p>
        <p className="t-sm muted">
          다시 로그인한 뒤 5분 안에 {reauthWhat}
          {purpose.kind === 'device' ? '을' : '를'} 마쳐야 합니다.
        </p>
        <div className="col" style={{ gap: 8 }}>
          <button className={`btn ${provider.btn} btn-lg btn-block`} type="button" onClick={confirmReauth}>
            <i className={`prov ${provider.prov}`} aria-hidden="true" />
            {provider.label}로 다시 로그인하고 계속
          </button>
          <button className="btn btn-ghost btn-block" type="button" onClick={close}>
            닫기
          </button>
        </div>
      </WebShellModal>

      {overlay?.kind === 'withdraw' ? (
        <WithdrawSheet
          refund={overlay.refund}
          provider={provider.label}
          quote={quote}
          descId={`${ids}-wd`}
          onClose={close}
          onConfirm={() => confirmWithdraw(overlay.refund)}
        />
      ) : null}
    </FlowsContext.Provider>
  );
}

/** ② 로그인한 기기 목록(CMP-052). 로그아웃 버튼은 재인증 창을 연다 */
export function SettingsDevices() {
  const { devices, devicesLoading, onDeviceLogout } = useContext(FlowsContext);
  return <DeviceSessionList label="로그인한 기기 목록" sessions={devices} loading={devicesLoading} onLogout={onDeviceLogout} />;
}

/** ⑥ ( 회원 탈퇴 › ) — 재인증부터 연다 */
export function WithdrawStartButton({ className }: { className?: string }) {
  const { startWithdraw } = useContext(FlowsContext);
  return (
    <button className={className} type="button" aria-haspopup="dialog" onClick={startWithdraw}>
      회원 탈퇴
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </button>
  );
}

/** 회원 코드 복사(이름에 코드를 담는다) */
export function CopyCodeButton({ code }: { code: string }) {
  const toast = useToast();
  return (
    <button
      className="btn btn-outline btn-sm"
      type="button"
      aria-label={`회원 코드 ${code} 복사`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          toast('회원 코드를 복사했습니다', 'ic-copy');
        } catch {
          toast('복사하지 못했습니다', 'ic-copy');
        }
      }}
    >
      <i className="ic ic-copy" aria-hidden="true" />
      복사
    </button>
  );
}

const DESTRUCTIVE_BUTTON_STYLE = { height: 'auto', minHeight: 52, padding: '12px 16px', whiteSpace: 'normal', flexDirection: 'column', gap: 2 } as const;

function WithdrawSheet({
  refund,
  provider,
  quote,
  descId,
  onClose,
  onConfirm,
}: {
  refund: 'none' | 'vb-now' | 'vb-later';
  provider: string;
  quote: WithdrawQuote;
  descId: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const basic = refund === 'none';
  return (
    <WebShellModal
      open
      onClose={onClose}
      // 보드처럼 재인증 결과 줄을 제목 위에 둔다
      eyebrow={
        <p className="row t-sm tx-success" style={{ gap: 6 }}>
          <i className="ic ic-check-circle ic-16" aria-hidden="true" />
          {provider}로 다시 로그인했습니다
        </p>
      }
      title="회원 탈퇴"
      describedBy={descId}
      maxWidth={480}
      scroll
    >
      <p className="t-sm" id={descId}>
        탈퇴하면 주문·결제 기록은 법에 따라 5년간 분리 보관 후 파기됩니다
      </p>
      {/* 환급 예상(CMP-054)을 결과 버튼보다 먼저 읽게 둔다(d2 §4) */}
      <section className="card-flat col px-4 py-3.5 md:p-4" style={{ gap: 10 }} aria-labelledby={`${descId}-rq`}>
        <h3 className="t-sm fw-b" id={`${descId}-rq`}>
          미사용 티켓 환급 예상
        </h3>
        <p className="t-sm">
          미사용 티켓 {quote.ticketCount}장은 취소되고 예상 환급액은 {formatWon(quote.refund)}입니다. 다른 분에게 넘기려면 탈퇴 전에 양도해 주세요(받는 분이 수락해야 넘어갑니다).
        </p>
        {basic ? <p className="t-xs muted">{quote.summary}</p> : null}
        <dl className="kv">
          <dt>결제 금액</dt>
          <dd>{formatWon(quote.paid)}</dd>
          <dt>취소 수수료</dt>
          <dd>{formatWon(quote.fee)}</dd>
          <dt className="kv-total">예상 환급액</dt>
          <dd className="kv-total">{formatWon(quote.refund)}</dd>
        </dl>
        {basic ? (
          <p className="t-xs muted">관람일 10일 전까지는 취소 수수료가 없습니다(공정거래위원회 소비자분쟁해결기준). 환급은 3영업일 안에 결제한 수단으로 돌아갑니다.</p>
        ) : null}
      </section>
      {basic ? (
        <div className="card-flat col px-4 py-3.5 md:p-4" style={{ gap: 8 }}>
          <p className="t-sm">받은 티켓 {quote.receivedCount}장은 결제한 분에게 돌아갑니다. 환급은 결제한 분이 정합니다.</p>
          <p className="t-sm">
            양도 요청 중인 티켓 {quote.transferPendingCount}장은 요청을 철회하고 취소합니다. 양도를 마치려면 받는 분이 수락한 뒤 탈퇴해 주세요.
          </p>
          <Link className="link-more" href={quote.transferPendingHref} style={{ alignSelf: 'flex-start' }}>
            요청 보기
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <div className="card-flat col px-4 py-3.5" style={{ gap: 10 }}>
          <p className="t-sm">받은 양도 요청 1건은 거절됩니다.</p>
          {refund === 'vb-now' ? (
            <>
              <p className="t-sm" id={`${descId}-vb`}>
                가상계좌로 결제한 티켓 1장은 환불받을 계좌가 필요합니다.
              </p>
              {/* CMP-062 refund와 같은 칸(autocomplete off, 계좌번호 inputmode numeric). 보드에 제출 버튼이 따로 없어 칸만 둔다 */}
              <Select id="wd-bank" label="은행" requiredMark autoComplete="off" placeholder="은행을 고르세요" options={BANKS} defaultValue="" />
              <TextField
                id="wd-acct"
                label="계좌번호"
                requiredMark
                type="text"
                inputMode="numeric"
                autoComplete="off"
                hint="계좌번호는 저장하지 않고 환불 요청에만 씁니다"
              />
              <TextField id="wd-holder" label="예금주" requiredMark type="text" autoComplete="off" />
            </>
          ) : (
            <p className="t-sm">가상계좌로 결제한 티켓 1장은 입장 기록이 마감된 뒤 환급합니다. 그때 알림으로 계좌를 받고, 환급이 끝나면 탈퇴가 처리됩니다.</p>
          )}
          <p className="t-sm">입금 대기 중인 주문 1건은 취소합니다. 탈퇴한 뒤에는 그 계좌로 입금하지 마세요.</p>
          <p className="t-sm">내가 결제해 다른 분에게 양도한 티켓 2장은 그대로 남습니다. 공연이 취소되면 환급은 결제한 수단으로 갑니다.</p>
          <p className="t-sm">보내기 전 굿즈·부가 상품 주문 1건은 취소하고 환급합니다. 배송 중인 주문은 그대로 보내고, 반품은 고객센터로 받습니다.</p>
        </div>
      )}
      <div className="row between wrap" style={{ gap: 8 }}>
        <Link className="link-more" href="/my/tickets">
          먼저 양도하기
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
        <span className="t-xs muted">탈퇴 뒤 바로 다시 가입할 수 있습니다</span>
      </div>
      <div className="col" style={{ gap: 8 }}>
        <button className="btn btn-danger btn-lg btn-block" type="button" style={DESTRUCTIVE_BUTTON_STYLE} onClick={onConfirm}>
          <span>탈퇴합니다.</span> <span className="t-sm fw-m">주문·결제 기록은 법에 따라 분리 보관 후 파기됩니다</span>
        </button>
        <button className="btn btn-ghost btn-block" type="button" onClick={onClose}>
          탈퇴하지 않고 닫기
        </button>
      </div>
    </WebShellModal>
  );
}
