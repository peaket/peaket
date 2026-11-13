// SCR-013 마이 티켓(월렛) 본문(d5 §5.13, d3 SCR-013 행, 캔버스 보드 SCR-013-m·t·d를 한 반응형으로 합쳤다).
// 목록(/my/tickets)과 티켓 펼침(/my/tickets/[ticketId])이 함께 쓴다. 보드처럼 다가오는 공연 목록 안에서 한 장을 펼쳐 회전 QR을 보인다.
// 휴대폰: 카드 세로 목록, 펼친 카드는 머리 → 좌석 정보 → QR(폭 90%) → 부가 상품·행동·예매 확인서.
// 태블릿(md): 펼친 카드는 전체 폭, 안은 QR 320 + 오른쪽 정보 두 칸. 나머지 카드는 2열 격자.
// 데스크톱(lg): 가운데 1040 폭, 펼친 카드 안은 12칸 격자(왼쪽 5칸 · 오른쪽 7칸). 보드 d의 기본은 '데스크톱이면 휴대폰 등록 안내를 먼저'다.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { EmptyState } from '@peaket/ds/EmptyState';
import { NoticeBanner } from '@peaket/ds/NoticeBanner';
import { previewHref } from '@peaket/ds/Preview';
import { QrPattern, RotatingQR } from '@peaket/ds/RotatingQR';
import { Stepper } from '@peaket/ds/Stepper';
import { ProductionPoster } from '@/entities/production';
import { DeviceQr, type DeviceQrSnapshot } from '@/features/wallet-device-key/ui/DeviceQr';
import { OfflineBanner } from '@/features/wallet-device-key/ui/OfflineBanner';
import { cx } from '@/shared/lib/cx';
import { InAppBrowserNotice } from '@/shared/ui/InAppBrowserNotice';
import { PAST, T1, T2, T3, WALLET, walletView, type WalletState, type WalletView } from '../model/wallet';
import { BoothReissue, CopyNoButton, GoButton, ReturnToPayerButton, ToastButton } from './WalletClient';

export interface WalletProps {
  state: WalletState;
  /** 지금 화면 경로(상태 이동 링크에 쓴다) */
  path: string;
  dark: boolean;
}

type Go = (state: WalletState) => string;

const H2 = 't-md fw-b lg:text-[20px] lg:leading-[27px]';
const OUTLINE = 'btn btn-outline px-1.5 lg:px-4';

export function Wallet({ state, path, dark }: WalletProps) {
  const v = walletView(state);
  const go: Go = (s) => previewHref(path, s, { theme: dark ? 'dark' : undefined });

  return (
    <>
      <OfflineBanner forceOffline={v.offline} fallbackLastSyncText={v.offline ? WALLET.lastSyncOffline : undefined} />
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[1040px] gap-6 px-4 pt-5 pb-10 md:gap-7 md:px-6 md:pb-12 lg:gap-8 lg:px-8 lg:pt-8 lg:pb-16">
          <h1 className="t-xl lg:text-[32px] lg:leading-[42px]">마이 티켓</h1>

          {v.empty ? (
            <EmptyState
              icon="ticket"
              title="아직 티켓이 없습니다"
              description="예매를 마치면 티켓이 여기에 나타납니다."
              style={{ padding: '56px 16px' }}
              actions={
                <Link className="link-more" href="/search">
                  공연 둘러보기
                  <i className="ic ic-chevron-right" aria-hidden="true" />
                </Link>
              }
            />
          ) : (
            <>
              <section className="col gap-3 lg:gap-4" aria-labelledby="h-up">
                <h2 className={H2} id="h-up">
                  다가오는 공연
                </h2>
                <div className="grid gap-3 md:grid-cols-2 md:items-start md:gap-x-4 lg:gap-x-6 lg:gap-y-4">
                  {v.t1Open ? <FirstTicket v={v} go={go} path={path} /> : null}
                  <FirstTicketFolded v={v} />
                  {v.show8 ? <TransferPendingCard /> : null}
                  {v.recvClosed ? <ReceivedCard offline={v.offline} /> : null}
                  {v.recvOpen ? <ReceivedOpen /> : null}
                  {v.recvReclaimed ? (
                    <MiniCard
                      hid="t3x-h"
                      title={T1Title}
                      sub={
                        <>
                          <p className="t-sm muted">
                            {T3.whenText} · {T3.seat} · 게이트 {T3.gate}
                          </p>
                          <p className="t-sm">보낸 분 &apos;{T3.from}&apos;</p>
                        </>
                      }
                      badge={<span className="badge badge-danger">회수됨</span>}
                    >
                      <p className="t-sm">계정 보호 절차로 결제한 분에게 돌아갔습니다</p>
                    </MiniCard>
                  ) : null}
                </div>
              </section>

              <section className="col gap-3 lg:gap-4" aria-labelledby="h-past">
                <h2 className={H2} id="h-past">
                  지난 공연
                </h2>
                <div className="grid gap-3 md:grid-cols-2 md:gap-4 lg:gap-6">
                  <article className="card-flat col gap-1.5 px-4 py-[14px] lg:px-5 lg:py-4" aria-labelledby="t9-h">
                    <div className="row between items-start gap-2">
                      <h3 className="t-md fw-b muted" id="t9-h">
                        {PAST.title}
                      </h3>
                      <span className="row gap-1">
                        <span className="badge">지난 공연</span>
                        <span className="badge">입장함 {PAST.enteredText}</span>
                      </span>
                    </div>
                    <p className="t-sm muted">
                      {PAST.whenText} · {PAST.venueName} · 게이트 {PAST.gate}
                    </p>
                  </article>
                </div>
              </section>

              <div className="col gap-6 md:gap-4">
                <NoticeBanner tone="info" icon="home" role={null} className="lg:hidden">
                  홈 화면에 추가하면 인터넷 없이 열립니다{' '}
                  <Link className="link-more" href="/help">
                    방법
                    <i className="ic ic-chevron-right" aria-hidden="true" />
                  </Link>
                </NoticeBanner>
                {v.offline ? (
                  <div className="col items-center gap-1.5 md:flex-row md:gap-3">
                    <button className="btn btn-outline btn-block md:w-auto" type="button" aria-disabled="true" aria-describedby="sync-off">
                      <i className="ic ic-refresh" aria-hidden="true" />
                      지금 동기화
                    </button>
                    <p className="t-xs muted" id="sync-off">
                      인터넷에 연결되면 동기화할 수 있습니다
                    </p>
                  </div>
                ) : (
                  <div className="col items-center gap-1.5 md:flex-row md:gap-3">
                    <ToastButton className="btn btn-outline btn-block md:w-auto" message="최신 상태로 동기화했습니다">
                      <i className="ic ic-refresh" aria-hidden="true" />
                      지금 동기화
                    </ToastButton>
                    <p className="t-xs muted lg:text-[14px] lg:leading-[19px]">마지막 동기화: 방금</p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </main>
    </>
  );
}

const T1Title = T1.title;

/** 오프라인 진입 때 IndexedDB에 남길 티켓 스냅샷(화면 목업 값, 서버 연결 단계에서 티켓 API 응답으로 바뀐다) */
const T1_SNAPSHOT: DeviceQrSnapshot = { title: T1.title, whenText: T1.whenText, venueName: T1.venueName, seat: T1.seat, gate: T1.gate };
const T3_SNAPSHOT: DeviceQrSnapshot = { title: T1.title, whenText: T3.whenText, venueName: T1.venueName, seat: T3.seat, gate: T3.gate };

/** 카드 머리의 포스터(보드 .poster-sm, 휴대폰 48 · 태블릿 이상 56) */
function Poster() {
  return <ProductionPoster art="lumen" size="sm" title="LUMEN" label={`${T1.title} 포스터`} className="w-[48px] shrink-0 md:w-[56px]" />;
}

/** 접힌 티켓 카드(CMP-028 wallet). flat이면 회색(환급됨·지난 공연) */
function MiniCard({
  hid,
  title,
  sub,
  badge,
  flat = false,
  gap = 'gap-[10px]',
  children,
  className,
}: {
  hid: string;
  title: string;
  sub: ReactNode;
  badge: ReactNode;
  flat?: boolean;
  gap?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <article
      className={cx('col', flat ? 'card-flat gap-1.5 px-4 py-[14px] lg:px-5 lg:py-4' : cx('card p-4 lg:p-5', gap), className)}
      aria-labelledby={hid}
    >
      <div className="row between items-start gap-2">
        <div className="col min-w-0 gap-1">
          <h3 className={cx('t-md fw-b', flat && 'muted')} id={hid}>
            {title}
          </h3>
          {sub}
        </div>
        {badge}
      </div>
      {children}
    </article>
  );
}

const t1Sub = (
  <p className="t-sm muted">
    {T1.whenText} · {T1.seat} · 게이트 {T1.gate}
  </p>
);

function DetailLink({ href, label, children }: { href: string; label?: string; children: ReactNode }) {
  return (
    <Link className="link-more" href={href} aria-label={label}>
      {children}
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </Link>
  );
}

/** 첫 티켓이 접힌 모양(받은 티켓을 펼침·취소 접수·공연 취소·일정 변경·입장·취소 무효·환급) */
function FirstTicketFolded({ v }: { v: WalletView }) {
  const orderHref = `/my/orders/${T1.orderId}`;
  const ticketHref = `/my/tickets/${T1.id}`;
  return (
    <>
      {v.t1Closed ? (
        <MiniCard hid="t1c-h" title={T1Title} sub={t1Sub} badge={<span className="badge badge-success">사용 가능</span>}>
          <DetailLink href={ticketHref} label={`${T1.seat} 티켓 보기`}>
            티켓 보기
          </DetailLink>
        </MiniCard>
      ) : null}
      {v.t1CancelReq ? (
        <MiniCard hid="t1r-h" title={T1Title} sub={t1Sub} badge={<span className="badge badge-warning">취소 접수됨</span>}>
          <p className="t-sm">입장 기록 마감 뒤 환급됩니다</p>
          <p className="t-xs muted">입장이 시작된 뒤 취소해 이 티켓은 바로 쓸 수 없게 되었습니다. 입장하지 않은 것이 확인되면 환급합니다.</p>
          <DetailLink href={orderHref}>예매·주문 내역에서 진행 상태 보기</DetailLink>
        </MiniCard>
      ) : null}
      {v.t1EvtCancel ? (
        <MiniCard hid="t1e-h" title={T1Title} sub={t1Sub} badge={<span className="badge badge-danger">공연 취소됨</span>}>
          <p className="t-sm">환급이 진행 중입니다</p>
          <DetailLink href={orderHref}>예매·주문 내역에서 진행 상태 보기</DetailLink>
        </MiniCard>
      ) : null}
      {v.t1Postponed ? (
        <MiniCard
          hid="t1p-h"
          title={T1Title}
          sub={
            <p className="t-sm muted">
              {T1.seat} · 게이트 {T1.gate}
            </p>
          }
          badge={<span className="badge badge-warning">일정 변경</span>}
        >
          <p className="t-sm">새 일정 {T1.postponedText} · 원하면 환급을 신청할 수 있습니다</p>
          <DetailLink href={previewHref(`/my/tickets/${T1.id}/cancel`, '연기 환급')} label={`${T1.seat} 환급 신청`}>
            환급 신청
          </DetailLink>
        </MiniCard>
      ) : null}
      {v.t1Entered ? (
        <>
          <MiniCard hid="t1in-h" title={T1Title} sub={t1Sub} badge={<span className="badge badge-success">입장함 {T1.enteredText} {T1.gate}</span>}>
            <DetailLink href={ticketHref} label={`${T1.seat} 티켓 보기`}>
              티켓 보기
            </DetailLink>
          </MiniCard>
          <MiniCard
            hid="t2out-h"
            title={T1Title}
            sub={
              <p className="t-sm muted">
                {T1.whenText} · {T2.seat} · 게이트 {T1.gate}
              </p>
            }
            badge={<span className="badge">퇴장함</span>}
          >
            <DetailLink href={`/my/tickets/${T2.id}`} label={`${T2.seat} 티켓 보기`}>
              티켓 보기
            </DetailLink>
          </MiniCard>
        </>
      ) : null}
      {v.t1CancelVoid ? (
        <MiniCard hid="t1v-h" title={T1Title} sub={t1Sub} badge={<span className="badge badge-danger">취소 무효</span>}>
          <p className="t-sm">취소 접수 뒤 입장 기록이 확인되어 취소가 무효가 되었습니다</p>
          <DetailLink href={orderHref}>예매·주문 내역에서 보기</DetailLink>
        </MiniCard>
      ) : null}
      {v.t1Refunded ? (
        <MiniCard hid="t1f-h" title={T1Title} sub={t1Sub} badge={<span className="badge">환급됨</span>} flat>
          <DetailLink href={orderHref}>예매·주문 내역에서 보기</DetailLink>
        </MiniCard>
      ) : null}
    </>
  );
}

/** 좌석·게이트·입장 시작·예매번호. 휴대폰은 카드 머리 아래, 태블릿 이상은 QR 오른쪽에 둔다 */
function TicketFacts({ wide }: { wide: boolean }) {
  return (
    <dl
      className={cx(
        wide ? 'hidden md:grid' : 'grid md:hidden',
        'grid-cols-2 gap-3 md:gap-x-3 md:gap-y-[14px] lg:grid-cols-3 lg:gap-x-5 lg:gap-y-4',
      )}
    >
      <div className="col col-span-full gap-0.5">
        <dt className="eyebrow">좌석</dt>
        <dd className="t-xl lg:text-[32px] lg:leading-[42px]">{T1.seat}</dd>
      </div>
      <div className="col gap-0.5">
        <dt className="eyebrow">입장 게이트</dt>
        <dd className="t-lg">{T1.gate}</dd>
      </div>
      <div className="col gap-0.5">
        <dt className="eyebrow">입장 시작</dt>
        <dd className="t-lg num">{T1.gateOpenText}</dd>
      </div>
      {/* 예매번호: 휴대폰·태블릿은 양끝 한 줄, 데스크톱은 세 번째 칸 */}
      <div className="row between col-span-full gap-2 lg:col-span-1 lg:flex-col lg:items-start lg:justify-start lg:gap-0.5">
        <dt className="t-sm muted lg:text-[12px] lg:leading-[16px] lg:font-bold lg:tracking-[.02em]">예매번호</dt>
        <dd className="row gap-0.5">
          <span className="mono t-sm">{T1.bookingNo}</span>
          <CopyNoButton text={T1.bookingNo} label={`예매번호 ${T1.bookingNo} 복사`} />
        </dd>
      </div>
    </dl>
  );
}

/** 회전 QR 아래 안내 세 줄 */
function QrHints() {
  return (
    <ul className="col t-sm gap-2 self-stretch px-[15px] md:px-0">
      {[
        { icon: 'ic-wifi-off', text: '인터넷이 없어도 QR이 표시됩니다' },
        { icon: 'ic-sun', text: '화면 밝기를 올려 주세요. 밝기는 자동으로 바꿀 수 없습니다' },
        { icon: 'ic-phone', text: 'QR이 보이는 동안 화면이 꺼지지 않게 합니다' },
      ].map((h) => (
        <li key={h.icon} className="row items-start gap-2">
          <i className={`ic ${h.icon} ic-16 muted mt-0.5`} aria-hidden="true" />
          <span>{h.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** 펼친 첫 티켓(CMP-028 wallet + CMP-029 RotatingQR) */
function FirstTicket({ v, go, path }: { v: WalletView; go: Go; path: string }) {
  const guide = v.desktopGuide;
  const mobileOnly = guide ? 'lg:hidden' : undefined;
  return (
    <article className="card overflow-hidden md:col-span-2" aria-labelledby="t1-h">
      <div className="col gap-[14px] p-4 md:px-5 md:pt-5 md:pb-0 lg:px-7 lg:pt-6">
        <div className="row items-start gap-3 md:gap-[14px] lg:gap-4">
          <Poster />
          <div className="col grow gap-1">
            <div className="row between items-start gap-2 lg:gap-3">
              <h3 className="t-md fw-b md:text-[20px] md:leading-[27px] lg:text-[24px] lg:leading-[32px]" id="t1-h">
                {T1.title}
              </h3>
              {v.t1BadgeOk ? <span className={cx('badge badge-success', mobileOnly)}>사용 가능</span> : null}
              {v.t1BadgeOk && guide ? <span className="badge hidden lg:inline-flex">키 없음</span> : null}
              {!v.t1BadgeOk ? <span className="badge">키 없음</span> : null}
            </div>
            <p className="t-sm muted lg:text-[16px] lg:leading-[22px]">
              {T1.whenText} · {T1.venueName}
            </p>
          </div>
        </div>
        <TicketFacts wide={false} />
      </div>

      <div className="md:grid md:grid-cols-[320px_minmax(0,1fr)] md:items-start md:gap-7 md:p-5 lg:grid-cols-12 lg:gap-x-6 lg:gap-y-6 lg:px-7 lg:pt-6 lg:pb-7">
        <div className="lg:col-span-5">
          {v.showQr ? (
            <div className={cx('col items-center gap-3 px-px pb-[18px] md:p-0', mobileOnly)}>
              {v.qrStale ? (
                // 'QR 15초 지남'은 디자인 미리보기다. 실제 기기 키가 없어도 보드와 같은 지난 QR을 그린다.
                <RotatingQR
                  label={`입장 QR, 티켓 ${T1.qrTicketId}, ${T1.seat}, 15초마다 바뀝니다`}
                  seed={17}
                  startTime={WALLET.nowStaleText}
                  running={false}
                  stale
                />
              ) : (
                <DeviceQr
                  ticketId={T1.qrUuid}
                  label={`입장 QR, 티켓 ${T1.qrTicketId}, ${T1.seat}, 15초마다 바뀝니다`}
                  offline={v.offline}
                  snapshot={T1_SNAPSHOT}
                />
              )}
              <QrHints />
            </div>
          ) : null}

          {v.noKey ? (
            <div className={cx('col gap-[10px] px-4 pb-[18px] md:p-0', mobileOnly)}>
              <div className="card-flat col items-center gap-3 px-4 py-7 text-center">
                <span className="state-icon is-primary">
                  <i className="ic ic-phone" aria-hidden="true" />
                </span>
                <p className="t-md fw-b">입장할 때 쓸 휴대폰을 등록해야 QR이 나옵니다</p>
                {v.keyRevoked ? <p className="t-sm">계정을 합치거나 티켓을 다시 받아 전에 등록한 입장 키가 폐기되었습니다. 다시 등록해 주세요</p> : null}
                {v.keyIos ? (
                  <>
                    <p className="t-sm">홈 화면에 추가한 앱에서 등록하세요</p>
                    <DetailLink href="/help" label="홈 화면에 추가하는 방법">
                      방법
                    </DetailLink>
                  </>
                ) : null}
                <InAppBrowserNotice next={`/my/tickets/${T1.id}`} />
                {v.keyBtn ? (
                  <>
                    <p className="t-sm muted">등록한 휴대폰에서만 입장 QR이 만들어집니다. 공연장에 가져갈 휴대폰에서 등록하세요.</p>
                    <GoButton className="btn btn-primary btn-lg btn-block" label={`${T1.seat}, 이 휴대폰을 입장용으로 등록`} href={go('기본(QR 펼침)')}>
                      이 휴대폰을 입장용으로 등록
                    </GoButton>
                  </>
                ) : null}
              </div>
              <p className="t-xs muted">입장 시작 24시간 전까지 등록하지 않으면 다시 알려 드립니다.</p>
            </div>
          ) : null}

          {guide ? (
            // 데스크톱(보드 d): 휴대폰 등록 안내를 먼저 보이고 '그래도 이 기기에 등록'을 둔다(offline-gate §2)
            <div className="card-flat col hidden gap-[14px] px-6 py-7 lg:flex">
              <span className="state-icon is-primary">
                <i className="ic ic-phone" aria-hidden="true" />
              </span>
              <h4 className="t-lg">입장 QR은 휴대폰에서 등록하세요</h4>
              {v.keyRevoked ? <p className="t-sm">계정을 합치거나 티켓을 다시 받아 전에 등록한 입장 키가 폐기되었습니다. 다시 등록해 주세요</p> : null}
              <InAppBrowserNotice next={`/my/tickets/${T1.id}`} />
              <p className="t-sm">
                입장할 때 쓸 휴대폰을 등록해야 QR이 나옵니다. 공연장에 가져갈 휴대폰에서 피켓에 로그인하고 마이 티켓을 연 뒤 &apos;이 휴대폰을 입장용으로
                등록&apos;을 누르세요.
              </p>
              <p className="t-sm muted" id="d-why">
                이 컴퓨터에 등록하면 공연 당일 휴대폰에서는 티켓을 다시 받아야 합니다. 다시 받기는 티켓당 24시간에 1번만 할 수 있습니다.
              </p>
              <ToastButton className="btn btn-text" label={`${T1.seat}, 그래도 이 기기에 등록`} message="이 기기를 입장용으로 등록했습니다">
                그래도 이 기기에 등록
                <i className="ic ic-chevron-right" aria-hidden="true" />
              </ToastButton>
            </div>
          ) : null}

          {v.lostAfter ? (
            <div className="col gap-[14px] px-4 pb-[18px] md:p-0">
              <NoticeBanner tone="warning" role="alert" title="이 휴대폰에서 티켓을 다시 받아야 합니다">
                입장이 시작되어 온라인으로는 다시 받을 수 없습니다. 현장 부스에서 다시 받을 수 있습니다.
              </NoticeBanner>
              <ol className="col t-sm gap-[10px]">
                {[
                  '본인확인 결과를 이 티켓의 계정과 대조하는 데 동의합니다',
                  '휴대폰 본인확인을 합니다',
                  '10분 동안 나오는 부스 코드 QR을 부스 직원에게 보여 줍니다',
                ].map((t, i) => (
                  <li key={t} className="row items-start gap-[10px]">
                    <span className="step-num">{i + 1}</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ol>
              <BoothReissue seat={T1.seat} showButton={v.boothBtn} initialOpen={v.consentOpen} nextHref={go('부스 코드(10분)')} />
              {v.boothLimit ? (
                <NoticeBanner tone="danger" role="alert">
                  오늘은 부스 재발급을 더 요청할 수 없습니다(하루 3회)
                </NoticeBanner>
              ) : null}
              {v.boothMismatch ? (
                <NoticeBanner tone="danger" role="alert">
                  본인확인 결과가 이 티켓의 계정과 다릅니다
                </NoticeBanner>
              ) : null}
            </div>
          ) : null}

          {v.lostBefore ? (
            <div className="col gap-[14px] px-4 pb-[18px] md:p-0">
              <NoticeBanner tone="warning" role="alert" title="이 기기에서 티켓을 다시 받아야 합니다">
                휴대폰이 저장 공간을 정리하며 이 기기의 입장 키가 지워졌습니다. 입장 시작 전이라 다시 로그인하면 이 휴대폰에서 바로 받을 수 있습니다.
              </NoticeBanner>
              {v.reissueBtn ? (
                <>
                  <Link className="btn btn-primary btn-lg btn-block" href={`/login?next=${encodeURIComponent(path)}`} aria-label={`${T1.seat}, 다시 로그인하고 받기`}>
                    다시 로그인하고 받기
                  </Link>
                  <p className="t-xs muted">티켓마다 24시간에 한 번 다시 받을 수 있고, 받으면 이메일로 알려 드립니다</p>
                </>
              ) : null}
              {v.reissueLimit ? (
                <>
                  <NoticeBanner tone="danger" role="alert">
                    24시간 안에 이미 다시 받았습니다(티켓당 24시간에 1번). 고객센터로 문의해 주세요
                  </NoticeBanner>
                  <span className="self-center">
                    <DetailLink href="/help/inquiries/new">문의하기</DetailLink>
                  </span>
                </>
              ) : null}
            </div>
          ) : null}

          {v.boothCode ? (
            <div className="col gap-[14px] px-4 pb-[18px] md:p-0">
              <Stepper label="부스 재발급 단계" steps={['동의', '본인확인', '부스 코드']} current={2} style={{ gap: 6 }} />
              <div className="card-flat col items-center gap-3 px-4 py-5 text-center">
                <span className="badge badge-solid">부스 코드 · 입장 QR이 아닙니다</span>
                <QrPattern label={`부스 재발급 코드 QR, 티켓 ${T1.qrTicketId}`} seed={53} maxWidth={200} />
                <span className="mono t-lg">{WALLET.boothCode}</span>
                <span className="timer" role="timer" aria-label={`부스 코드 남은 시간 ${WALLET.boothRemainLabel}`}>
                  <i className="ic ic-clock" aria-hidden="true" />
                  {WALLET.boothRemainText} 남음
                </span>
                <p className="t-md fw-b">부스 직원에게 이 화면을 보여 주세요</p>
                <p className="t-sm muted">
                  부스 직원이 코드를 찍으면 10분 안에 이 휴대폰을 입장용으로 다시 등록합니다. 코드가 만료되면 부스 재발급을 다시 요청해야 합니다.
                </p>
              </div>
            </div>
          ) : null}
        </div>

        <div className="col gap-4 border-t border-(--border) p-4 md:gap-[18px] md:border-t-0 md:p-0 lg:col-span-7 lg:gap-5">
          <TicketFacts wide />
          <div className="divider hidden md:block" />
          <div className="row gap-3">
            <span className="state-icon" style={{ width: 40, height: 40 }}>
              <i className="ic ic-box" aria-hidden="true" style={{ width: 20, height: 20 }} />
            </span>
            <div className="col grow gap-0.5">
              <span className="t-xs muted">연동 부가 상품</span>
              <span className="t-md fw-b">{T1.addon}</span>
            </div>
          </div>
          <TicketActions v={v} />
          <Link
            className="row min-h-12 gap-3 rounded-(--r-lg) border border-(--border) px-3 py-2.5 lg:px-[14px]"
            href={`/my/orders/${T1.orderId}`}
            style={{ color: 'inherit' }}
          >
            <i className="ic ic-receipt muted" aria-hidden="true" />
            <span className="col grow gap-0.5">
              <span className="t-sm fw-b">예매 확인서 보기</span>
              <span className="t-xs muted">판매자 정보와 통신판매중개자 고지</span>
            </span>
            <i className="ic ic-chevron-right muted" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </article>
  );
}

/** 양도·부가 상품·예매 취소(③). 마감 규칙·오프라인이면 이유 있는 비활성(aria-disabled + 이유 글) */
function TicketActions({ v }: { v: WalletView }) {
  const base = `/my/tickets/${T1.id}`;
  const transferIcon = <i className="ic ic-transfer hidden lg:inline-block" aria-hidden="true" />;
  const addonIcon = <i className="ic ic-box hidden lg:inline-block" aria-hidden="true" />;
  const addonText = (
    <>
      부가 상품<span className="hidden lg:inline"> 보기</span>
    </>
  );
  const grid = 'grid grid-cols-3 gap-2 lg:flex lg:flex-wrap';
  const transferLink = (
    <Link className={OUTLINE} href={`${base}/transfer`} aria-label={`${T1.seat} 양도하기`}>
      {transferIcon}양도하기
    </Link>
  );
  const addonLink = (
    <Link className={OUTLINE} href={`${base}/addons`} aria-label={`${T1.seat} 연동 부가 상품 보기`}>
      {addonIcon}
      {addonText}
    </Link>
  );
  const cancelLink = (
    <Link className={OUTLINE} href={`${base}/cancel`} aria-label={`${T1.seat} 예매 취소`}>
      예매 취소
    </Link>
  );

  if (v.actOffline) {
    return (
      <div className="col gap-1.5 lg:gap-2">
        <div className={grid}>
          <button className={OUTLINE} type="button" aria-disabled="true" aria-describedby="t1-off">
            {transferIcon}양도하기
          </button>
          <button className={OUTLINE} type="button" aria-disabled="true" aria-describedby="t1-off">
            {addonIcon}
            {addonText}
          </button>
          <button className={OUTLINE} type="button" aria-disabled="true" aria-describedby="t1-off">
            예매 취소
          </button>
        </div>
        <p className="t-xs muted" id="t1-off">
          인터넷에 연결되면 양도·부가 상품·예매 취소를 할 수 있습니다
        </p>
      </div>
    );
  }
  if (v.actAfter) {
    return (
      <div className="col gap-1.5 lg:gap-2">
        <div className={grid}>
          <button className={OUTLINE} type="button" aria-disabled="true" aria-describedby="t1-aft">
            {transferIcon}양도하기
          </button>
          {addonLink}
          {cancelLink}
        </div>
        <p className="t-xs muted" id="t1-aft">
          양도 마감({T1.transferDeadlineText})이 지났습니다. 입장 시작 뒤 예매를 취소하면 환급은 입장 기록 마감 뒤에 합니다
        </p>
      </div>
    );
  }
  if (v.actNormal) {
    return (
      <div className="col gap-1.5 lg:gap-2">
        <div className={grid}>
          {transferLink}
          {addonLink}
          {cancelLink}
        </div>
        <p className="t-xs muted">양도는 {T1.transferDeadlineText}까지, 예매 취소는 공연 시작 전까지 할 수 있습니다</p>
      </div>
    );
  }
  return null;
}

/** 같은 주문 12열 8번: 양도 요청 중(CMP-059 TransferOfferCard sender). 취소는 철회 뒤에만 */
function TransferPendingCard() {
  return (
    <MiniCard
      hid="t2-h"
      title={T1Title}
      gap="gap-3"
      sub={
        <p className="t-sm muted">
          {T1.whenText} · {T2.seat} · 게이트 {T1.gate}
        </p>
      }
      badge={<span className="badge badge-warning">양도 요청 중</span>}
    >
      <div className="card-flat col gap-2 px-[14px] py-3" role="group" aria-label={`${T2.seat} 양도 요청`}>
        <div className="row between gap-2">
          <span className="t-sm">
            <strong>{T2.toMasked}</strong> 님에게 양도 요청
          </span>
          <span className="badge">수락 대기</span>
        </div>
        <p className="t-sm">
          <span className="num fw-b">{T2.remainingText}</span> 남음 · 수락 기한 {T2.acceptDeadlineText}
        </p>
        <div className="row between gap-2">
          <ToastButton className="btn btn-outline btn-sm" label={`${T2.seat} 양도 요청 철회`} message="양도 요청을 철회했습니다">
            요청 철회
          </ToastButton>
          <DetailLink href={previewHref(`/my/tickets/${T2.id}/transfer`, '요청 보냄')} label={`${T2.seat} 양도 요청 보기`}>
            요청 보기
          </DetailLink>
        </div>
      </div>
      <p className="t-xs muted">예매 취소: 양도 요청을 철회한 뒤 취소할 수 있습니다</p>
    </MiniCard>
  );
}

/** 받은 티켓(접힘): 돌려주기만 보인다(POL-019). 오프라인이면 이유 있는 비활성 */
function ReceivedCard({ offline }: { offline: boolean }) {
  const ticketLink = (
    <DetailLink href={`/my/tickets/${T3.id}`} label={`${T3.seat} 티켓 보기`}>
      티켓 보기
    </DetailLink>
  );
  return (
    <MiniCard
      hid="t3-h"
      title={T1Title}
      gap="gap-[10px] lg:gap-3"
      sub={
        <>
          <p className="t-sm muted">
            {T3.whenText} · {T3.seat} · 게이트 {T3.gate}
          </p>
          <p className="t-sm">보낸 분 &apos;{T3.from}&apos;</p>
        </>
      }
      badge={<span className="badge badge-primary">받은 티켓</span>}
    >
      <p className="t-xs muted hidden lg:block">받은 티켓은 다시 양도할 수 없고, 취소·환불은 결제한 분만 할 수 있습니다.</p>
      {offline ? (
        <>
          <div className="row between gap-2">
            <button className="btn btn-outline btn-sm" type="button" aria-disabled="true" aria-describedby="t3-off">
              결제자에게 돌려주기
            </button>
            {ticketLink}
          </div>
          <p className="t-xs muted" id="t3-off">
            인터넷에 연결되면 돌려줄 수 있습니다
          </p>
        </>
      ) : (
        <div className="row between gap-2">
          <ReturnToPayerButton seat={T3.seat} className="btn btn-outline btn-sm">
            결제자에게 돌려주기
          </ReturnToPayerButton>
          {ticketLink}
        </div>
      )}
    </MiniCard>
  );
}

/** 받은 티켓 펼침: QR은 보이고, 행동은 돌려주기 하나 */
function ReceivedOpen() {
  const facts = (wide: boolean) => (
    <dl className={cx(wide ? 'hidden md:grid' : 'grid md:hidden', 'grid-cols-[minmax(0,1fr)_auto] gap-3')}>
      <div className="col gap-0.5">
        <dt className="eyebrow">좌석</dt>
        <dd className="t-xl">{T3.seat}</dd>
      </div>
      <div className="col items-end gap-0.5">
        <dt className="eyebrow">입장 게이트</dt>
        <dd className="t-lg">{T3.gate}</dd>
      </div>
    </dl>
  );
  return (
    <article className="card overflow-hidden md:col-span-2" aria-labelledby="t3o-h">
      <div className="col gap-[14px] p-4 md:px-5 md:pt-5 md:pb-0 lg:px-7 lg:pt-6">
        <div className="row items-start gap-3 md:gap-[14px] lg:gap-4">
          <Poster />
          <div className="col grow gap-1">
            <div className="row between items-start gap-2">
              <h3 className="t-md fw-b md:text-[20px] md:leading-[27px] lg:text-[24px] lg:leading-[32px]" id="t3o-h">
                {T1.title}
              </h3>
              <span className="badge badge-primary">받은 티켓</span>
            </div>
            <p className="t-sm muted lg:text-[16px] lg:leading-[22px]">
              {T3.whenText} · {T1.venueName}
            </p>
            <p className="t-sm">보낸 분 &apos;{T3.from}&apos;</p>
          </div>
        </div>
        {facts(false)}
      </div>
      <div className="md:grid md:grid-cols-[320px_minmax(0,1fr)] md:items-start md:gap-7 md:p-5 lg:grid-cols-12 lg:gap-x-6 lg:px-7 lg:pt-6 lg:pb-7">
        <div className="col items-center gap-3 px-px pb-[18px] md:p-0 lg:col-span-5">
          <DeviceQr
            ticketId={T3.qrUuid}
            label={`입장 QR, 티켓 ${T3.qrTicketId}, 받은 티켓 ${T3.seat}, 15초마다 바뀝니다`}
            snapshot={T3_SNAPSHOT}
          />
          <p className="t-sm muted px-[15px] text-center md:px-0">인터넷이 없어도 QR이 표시됩니다 · 화면 밝기를 올려 주세요</p>
        </div>
        <div className="col gap-3 border-t border-(--border) p-4 md:gap-[18px] md:border-t-0 md:p-0 lg:col-span-7">
          {facts(true)}
          <div className="divider hidden md:block" />
          <NoticeBanner tone="info" role={null}>
            받은 티켓은 다시 양도할 수 없고, 취소·환불은 결제한 분만 할 수 있습니다. 결제한 분에게 돌려주기만 할 수 있습니다.
          </NoticeBanner>
          <ReturnToPayerButton seat={T3.seat} className="btn btn-outline btn-lg btn-block" describedBy="t3-ret">
            <i className="ic ic-undo" aria-hidden="true" />
            결제자에게 돌려주기
          </ReturnToPayerButton>
          <p className="t-xs muted" id="t3-ret">
            돌려주면 이 휴대폰의 입장 키가 지워집니다. 돌려주기 전에 카카오로 다시 로그인하며, 입장이 시작되면 돌려줄 수 없습니다.
          </p>
        </div>
      </div>
    </article>
  );
}
