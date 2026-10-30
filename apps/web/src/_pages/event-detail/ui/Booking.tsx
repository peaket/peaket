// SCR-002 회차·오픈·좌석 등급 묶음(⑪ CMP-066 RoundPicker, 등급별 가격 요약)과 예매 버튼(⑥ 알림 토글 · ⑦ 주 버튼).
// 휴대폰·태블릿은 히어로 안 묶음 + 화면 아래 고정 띠(bar), 데스크톱은 오른쪽 고정 예매 패널(panel)이다(d5 §5.2 'lg: 2단').
// 같은 묶음을 두 곳에 그리므로(한쪽은 display:none) id에 prefix를 붙여 겹치지 않게 한다.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { RoundPicker } from '@peaket/ds/RoundPicker';
import { listPerformances, eventHref, type Performance } from '@/entities/performance';
import { formatWon, type Production } from '@/entities/production';
import { VerifyIdentityButton } from '@/features/identity-verify';
import { OpenAlertToggle } from '@/features/open-alert';
import { cx } from '@/shared/lib/cx';
import { renderNextLink } from '@/shared/lib/next-link';
import { LobbyCountdown } from './DetailClient';
import { roundStatus, timeOf, type CtaContext, type DetailView } from '../model/view';

export function BookingFacts({
  prefix,
  view,
  production,
  perf,
  dividers = false,
  className,
}: {
  prefix: string;
  view: DetailView;
  production: Production;
  perf: Performance;
  dividers?: boolean;
  className?: string;
}) {
  const rounds = listPerformances(production.id).map((r) => ({
    id: r.id,
    label: r.label,
    href: eventHref(r.id),
    current: r.id === perf.id,
    status: roundStatus(view.rounds, r.id === perf.id),
  }));
  const gap = dividers ? 18 : 20;
  return (
    <div className={cx('col', className)} style={{ gap }}>
      <div className="col" style={{ gap: 10 }}>
        <h2 className="eyebrow" id={`${prefix}-h-round`}>
          회차
        </h2>
        <RoundPicker items={rounds} labelledBy={`${prefix}-h-round`} renderLink={renderNextLink} />
      </div>
      {dividers ? <div className="divider" /> : null}
      <div className="col" style={{ gap: 4 }}>
        <h2 className="eyebrow">오픈</h2>
        <p className="t-md">
          <span className="num">{production.openText}</span> KST
          {view.hasLobby && production.lobbyText ? (
            <>
              {' '}
              · 로비 <span className="num">{production.lobbyText}</span>부터
            </>
          ) : null}
        </p>
      </div>
      {dividers ? <div className="divider" /> : null}
      <div className="col" style={{ gap: 2 }}>
        <h2 className="eyebrow" id={`${prefix}-h-tier`}>
          좌석 등급
        </h2>
        <ul aria-labelledby={`${prefix}-h-tier`} aria-busy={view.tiers === 'loading' || undefined}>
          {production.tiers.map((t) => (
            <li key={t.grade} className="row between" style={{ minHeight: 48, borderBottom: '1px solid var(--border)' }}>
              <span className="row" style={{ gap: 12 }}>
                <strong className="t-md fw-b">{t.grade}</strong> <span className="t-md num">{formatWon(t.price)}</span>
              </span>{' '}
              <TierBadge mode={view.tiers} soldOut={Boolean(t.soldOut)} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function TierBadge({ mode, soldOut }: { mode: DetailView['tiers']; soldOut: boolean }) {
  switch (mode) {
    case 'pre':
      return <span className="badge badge-primary">오픈 예정</span>;
    case 'onsale':
      return soldOut ? <span className="badge badge-danger">매진</span> : <span className="badge badge-success">판매 중</span>;
    case 'soldout':
      return <span className="badge badge-danger">매진</span>;
    case 'ended':
      return <span className="badge">판매 종료</span>;
    case 'error':
      // 잔여석 조회 실패: 등급 배지 대신 '판매 중' 고정 문구(POL-029)
      return <span className="t-sm muted">판매 중</span>;
    default:
      return <span className="skel" style={{ width: 56, height: 22 }} />;
  }
}

/** 선예매 대상 배너(d5 §5.2 상태 '선예매 대상') */
export function PresaleBanner({ sellerName }: { sellerName: string }) {
  return (
    <section className="banner banner-success" role="region" aria-label="팬클럽 선예매">
      <i className="ic ic-check-circle" aria-hidden="true" />
      <div className="banner-body col" style={{ gap: 6 }}>
        <p>
          <strong>팬클럽 선예매 대상입니다.</strong> <span className="num">10/13(화) 20:00</span>부터 1인 2매까지 예매할 수 있습니다
        </p>
        <p className="t-sm muted">
          판매자({sellerName})가 보낸 팬클럽 선예매 명단에 회원님이 있습니다. 이 명단은 선예매 자격 확인에만 쓰고, 이 공연의 판매 기간이 끝나고 1일 뒤 지웁니다
        </p>
      </div>
    </section>
  );
}

type Primary =
  | { type: 'link'; label: string; href: string; external?: boolean; icon?: string }
  | { type: 'disabled'; label: string }
  /** [휴대폰 본인확인]: 누르면 본인확인 기관 창이 열린다(SCR-006, @/features/identity-verify) */
  | { type: 'verify'; label: string; icon?: string }
  | { type: 'countdown'; seconds: number; href: string };

interface CtaModel {
  /** 버튼 위(휴대폰)·왼쪽(태블릿) 한 줄. id는 비활성 버튼이 aria-describedby로 가리킨다 */
  desc?: ReactNode;
  descStatus?: boolean;
  /** 휴대폰에서 가운데 정렬하지 않는다(본인확인 목적 문구) */
  descStart?: boolean;
  /** desc가 없을 때 태블릿에서만 보이는 회차 줄 */
  meta?: string;
  /** 태블릿 띠에서 공연명 줄을 뺀다 */
  noTitle?: boolean;
  alert?: { kind: 'open' | 'cancel'; iconOnlyBelowMd?: boolean };
  primary?: Primary;
  /** 태블릿 주 버튼 최소 폭 */
  minW?: number;
  more?: { label: string; href: string };
  special?: 'limit' | 'ended' | 'load';
}

function ctaModel(c: CtaContext): CtaModel {
  const lobby = c.production.lobbyText ?? '';
  const same = '로비 안에서는 언제 들어와도 순번이 같습니다';
  switch (c.kind) {
    case 'lobby':
      return { desc: same, alert: { kind: 'open' }, primary: { type: 'link', label: '로비 입장', href: c.queueHref, external: true }, minW: 200 };
    case 'notYet':
      return { desc: same, alert: { kind: 'open', iconOnlyBelowMd: true }, primary: { type: 'countdown', seconds: 42, href: c.queueHref }, minW: 240 };
    case 'closed':
      return { desc: `로비는 ${lobby}에 열립니다`, alert: { kind: 'open' }, primary: { type: 'disabled', label: '로비 입장' }, minW: 200 };
    case 'presaleOut':
      return {
        desc: (
          <>
            이 회차의 선예매 대상이 아닙니다. 일반 예매는 <span className="num">{c.production.openText}</span>부터입니다
          </>
        ),
        alert: { kind: 'open' },
        primary: { type: 'disabled', label: '로비 입장' },
        minW: 160,
      };
    case 'queue':
      return { meta: `${c.perf.label} · 판매 중`, primary: { type: 'link', label: '대기열 들어가기', href: c.queueHref, external: true }, minW: 240 };
    case 'verify':
      return {
        desc: '휴대폰 본인확인은 계정당 한 번만 합니다. 한 사람은 한 계정으로만 예매할 수 있습니다',
        descStart: true,
        noTitle: true,
        alert: { kind: 'open', iconOnlyBelowMd: true },
        // 누르면 본인확인 기관 창(근사)이 바로 열리고 결과는 이 화면 위 대화상자다(SCR-006, 본문 버튼과 같은 흐름)
        primary: { type: 'verify', label: '휴대폰 본인확인', icon: 'ic-phone' },
      };
    case 'soldOut':
      return { meta: `${c.perf.label} · 매진`, alert: { kind: 'cancel' }, more: { label: '다른 회차', href: c.otherRoundHref } };
    case 'fifo':
      return { desc: `대기열은 ${timeOf(c.production.openText)}에 열립니다`, alert: { kind: 'open' }, primary: { type: 'disabled', label: '대기열 들어가기' }, minW: 200 };
    case 'busy':
      return {
        desc: (
          <>
            잠시 뒤 자동으로 다시 시도합니다 · <span className="num">18</span>초
          </>
        ),
        descStatus: true,
        primary: { type: 'disabled', label: '대기열 들어가기' },
        minW: 240,
      };
    case 'guest':
      return {
        meta: `${c.perf.label}${lobby ? ` · 로비 ${lobby}부터` : ''}`,
        alert: { kind: 'open' },
        primary: { type: 'link', label: '로그인하고 입장', href: c.loginHref },
        minW: 200,
      };
    case 'limit':
      return { special: 'limit', more: { label: '소명하기', href: c.appealHref } };
    case 'ended':
      return { special: 'ended', meta: `${c.perf.label} · 판매가 끝난 회차입니다`, more: { label: '다른 회차', href: c.otherRoundHref } };
    default:
      return { special: 'load', meta: `${c.perf.label} · 판매 중` };
  }
}

function PrimaryButton({ p, className, descId, verifyStatus = false }: { p: Primary; className: string; descId?: string; verifyStatus?: boolean }) {
  if (p.type === 'verify') {
    // 아래 고정 띠는 한 줄이라 진행 글을 버튼 아래에 두지 않는다(기관 창이 열려 진행이 보인다). 오른쪽 패널은 버튼 아래에 둔다
    return (
      <VerifyIdentityButton className={cx('btn btn-primary', className)} describedBy={descId} showStatus={verifyStatus}>
        {p.icon ? <i className={`ic ${p.icon}`} aria-hidden="true" /> : null}
        {p.label}
      </VerifyIdentityButton>
    );
  }
  if (p.type === 'countdown') return <LobbyCountdown seconds={p.seconds} href={p.href} describedBy={descId ?? ''} className={className} />;
  if (p.type === 'link') {
    const children = (
      <>
        {p.icon ? <i className={`ic ${p.icon}`} aria-hidden="true" /> : null}
        {p.label}
      </>
    );
    // 대기실(로비·대기열)은 별도 빌드(포트 3004)라 전체 이동이다
    return p.external ? (
      <a className={cx('btn btn-primary', className)} href={p.href}>
        {children}
      </a>
    ) : (
      <Link className={cx('btn btn-primary', className)} href={p.href}>
        {children}
      </Link>
    );
  }
  return (
    <button
      className={cx('btn btn-primary', className)}
      type="button"
      aria-disabled={p.type === 'disabled' ? 'true' : undefined}
      aria-describedby={descId}
    >
      {p.label}
    </button>
  );
}

function MoreLink({ more }: { more: { label: string; href: string } }) {
  return (
    <Link className="link-more" href={more.href}>
      {more.label}
      <i className="ic ic-chevron-right" aria-hidden="true" />
    </Link>
  );
}

const LIMIT_TEXT = (
  <>
    예매가 제한되어 있습니다 · 소명 기한 <span className="num">10/27</span>
  </>
);

/** 휴대폰·태블릿 화면 아래 고정 띠(보드 SCR-002-m·t의 .bottom-bar). 데스크톱(lg)에서는 숨긴다 */
export function BookingBar({ ctx }: { ctx: CtaContext }) {
  const m = ctaModel(ctx);
  const descId = m.desc ? `bar-${ctx.kind}-why` : undefined;
  let body: ReactNode;
  if (m.special === 'load') {
    body = (
      <div className="row gap-2 md:gap-3" aria-busy="true">
        <div className="col hidden min-w-0 grow gap-0.5 md:flex">
          <strong className="t-md fw-b ellipsis">{ctx.title}</strong>
          <span className="t-sm muted">{m.meta}</span>
        </div>
        <span className="sr-only">예매 버튼을 불러오는 중</span>
        <span className="skel h-[52px] w-[136px] flex-none md:hidden" />
        <span className="skel h-[52px] grow md:w-[240px] md:flex-none md:grow-0" />
      </div>
    );
  } else if (m.special === 'limit') {
    body = (
      <div className="col items-center gap-1.5 text-center md:flex-row md:gap-4 md:text-left">
        <div className="col min-w-0 md:grow" style={{ gap: 2 }}>
          <strong className="t-md fw-b ellipsis hidden md:block">{ctx.title}</strong>
          <p className="row t-md fw-b md:text-sm md:leading-[19px] md:font-normal md:text-(--text-muted)" style={{ gap: 6 }}>
            <i className="ic ic-ban ic-16 tx-danger" aria-hidden="true" />
            {LIMIT_TEXT}
          </p>
        </div>
        {m.more ? <MoreLink more={m.more} /> : null}
      </div>
    );
  } else if (m.special === 'ended') {
    body = (
      <div className="row between gap-4">
        <div className="col min-w-0" style={{ gap: 2 }}>
          <strong className="t-md fw-b ellipsis hidden md:block">{ctx.title}</strong>
          <p className="t-md fw-b md:hidden">판매가 끝난 회차입니다</p>
          <span className="t-sm muted hidden md:block">{m.meta}</span>
        </div>
        {m.more ? <MoreLink more={m.more} /> : null}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
        {m.desc || m.meta ? (
          <div className={cx('col min-w-0 gap-0.5 md:grow', !m.desc && 'hidden md:flex')}>
            {m.noTitle ? null : <strong className="t-md fw-b ellipsis hidden md:block">{ctx.title}</strong>}
            {m.desc ? (
              <p className={cx('t-sm muted', !m.descStart && 'text-center md:text-left')} id={descId} role={m.descStatus ? 'status' : undefined}>
                {m.desc}
              </p>
            ) : (
              <span className="t-sm muted">{m.meta}</span>
            )}
          </div>
        ) : null}
        <div className={cx('row gap-2 md:gap-3', m.more && 'gap-4')}>
          {m.alert ? (
            <OpenAlertToggle
              title={ctx.title}
              variant="button"
              kind={m.alert.kind}
              iconOnlyBelowMd={m.alert.iconOnlyBelowMd}
              className={cx('btn-lg', !m.primary && 'grow md:grow-0')}
            />
          ) : null}
          {m.primary ? (
            <PrimaryButton
              p={m.primary}
              descId={descId}
              className={cx('btn-lg grow md:flex-none md:grow-0', m.minW === 240 ? 'md:min-w-[240px]' : m.minW === 160 ? 'md:min-w-[160px]' : m.minW ? 'md:min-w-[200px]' : '')}
            />
          ) : null}
          {m.more ? <MoreLink more={m.more} /> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="bottom-bar sticky bottom-0 z-10 md:px-6 lg:hidden">
      <div className="w-full">{body}</div>
    </div>
  );
}

/** 데스크톱 오른쪽 고정 예매 패널의 버튼 묶음(보드 SCR-002-d aside) */
export function BookingPanelCta({ ctx }: { ctx: CtaContext }) {
  const m = ctaModel(ctx);
  const descId = m.desc ? `pnl-${ctx.kind}-why` : undefined;
  if (m.special === 'load') {
    return (
      <div className="col" style={{ gap: 8 }} aria-busy="true">
        <span className="sr-only">예매 버튼을 불러오는 중</span>
        <span className="skel" style={{ height: 40 }} />
        <span className="skel" style={{ height: 52 }} />
      </div>
    );
  }
  if (m.special === 'limit') {
    return (
      <div className="col" style={{ gap: 8 }}>
        <p className="row t-md fw-b" style={{ gap: 6 }}>
          <i className="ic ic-ban ic-16 tx-danger" aria-hidden="true" />
          {LIMIT_TEXT}
        </p>
        {m.more ? <MoreLink more={m.more} /> : null}
      </div>
    );
  }
  if (m.special === 'ended' || (m.more && !m.primary)) {
    return (
      <div className="col items-center" style={{ gap: 12 }}>
        {m.special === 'ended' ? <p className="t-md fw-b">판매가 끝난 회차입니다</p> : null}
        {m.alert ? <OpenAlertToggle title={ctx.title} variant="button" kind={m.alert.kind} className="btn-lg btn-block" /> : null}
        {m.more ? <MoreLink more={m.more} /> : null}
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 8 }}>
      {m.desc ? (
        <p className="t-sm muted" id={descId} role={m.descStatus ? 'status' : undefined}>
          {m.desc}
        </p>
      ) : null}
      {m.alert ? <OpenAlertToggle title={ctx.title} variant="button" kind={m.alert.kind} className="btn-block" /> : null}
      {m.primary ? <PrimaryButton p={m.primary} descId={descId} className="btn-lg btn-block" verifyStatus /> : null}
    </div>
  );
}
