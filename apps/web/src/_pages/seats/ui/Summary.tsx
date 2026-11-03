// 선택 요약(CMP-025 SeatSummary 자리): 휴대폰은 바텀 시트(.sheet), 태블릿은 아래 띠(.bottom-bar), 데스크톱은 오른쪽 패널 카드.
// 세 가지 요약: 고른 좌석(pick) · 아직 안 고름(empty) · 홀드한 좌석(hold, SCR-011에서 되돌아왔을 때). 보드 SCR-010-m·t·d 마크업 그대로.
// 같은 내용을 중단점마다 하나씩 그리고 보이는 것만 남기므로 id에 -m·-t·-d를 붙인다.
import Link from 'next/link';
import { formatWon } from '@/entities/production';
import type { HoldSummary } from '@/entities/hold';
import { cx } from '@/shared/lib/cx';
import type { SeatsView } from '../model/view';
import { NavButton } from './SeatControls';

export interface SummaryLinks {
  /** 좌석 홀드하기 성공 → SCR-011 */
  checkout: string;
  /** 예매 그만두기 → 공연 상세(홀드를 풀고 구매 세션을 끝낸다) */
  leave: string;
  /** 1회 연장 → '연장 뒤' */
  extend: string;
  /** 홀드한 좌석 풀기 → '방금 놓은 좌석'(직접 해제한 좌석은 30초 동안 흐리게, d5 §5.10) */
  release: string;
}

interface Props {
  view: SeatsView;
  hold: HoldSummary;
  links: SummaryLinks;
}

type Variant = 'm' | 't' | 'd';

function pickSub(view: SeatsView, hold: HoldSummary) {
  return view.overLimit
    ? `${hold.grade} ${hold.quantity}매 · 1인 ${hold.perPerson}매`
    : `${hold.grade} ${hold.quantity}매 · 남은 한도 ${hold.remaining}매(1인 ${hold.perPerson}매)`;
}

function LimitError() {
  return (
    <p className="error-msg" role="alert">
      <i className="ic ic-alert-circle" aria-hidden="true" />한 공연에서 최대 4매까지 구매할 수 있습니다
    </p>
  );
}

function HoldWhy({ view, v }: { view: SeatsView; v: Variant }) {
  if (!view.holdBlocked) return null;
  return (
    <p className={cx('t-sm fw-b', view.holdBlocked.danger && 'tx-danger')} id={`hold-why-${v}`}>
      {view.holdBlocked.text}
    </p>
  );
}

function HoldButton({ view, links, v, className }: { view: SeatsView; links: SummaryLinks; v: Variant; className: string }) {
  const blocked = !!view.holdBlocked;
  return (
    <NavButton href={links.checkout} className={className} disabled={blocked} describedBy={blocked ? `hold-why-${v}` : undefined}>
      좌석 홀드하기
    </NavButton>
  );
}

function ExtendButton({ view, links, v }: { view: SeatsView; links: SummaryLinks; v: Variant }) {
  return (
    <NavButton href={links.extend} className="btn btn-outline btn-sm" disabled={view.extended} describedBy={`ext-h-${v}`}>
      1회 연장
    </NavButton>
  );
}

const extText = (view: SeatsView) => (view.extended ? '이미 연장했습니다' : '홀드는 한 번, 3분 늘릴 수 있습니다');
const holdTimer = (view: SeatsView) =>
  view.hold ? (
    <span className={cx('timer', view.hold.tone === 'warning' && 'is-warning')} role="timer" aria-label={view.hold.ariaLabel}>
      <i className="ic ic-clock" aria-hidden="true" />
      {view.hold.text}
    </span>
  ) : null;

/** 휴대폰 바텀 시트 */
export function SummarySheet({ view, hold, links }: Props) {
  const v: Variant = 'm';
  if (view.summary === 'pick')
    return (
      <section className="sheet" aria-labelledby="sum-h-m" style={{ gap: 12 }}>
        <span className="sheet-handle" aria-hidden="true" />
        <div className="row between" style={{ alignItems: 'flex-start', gap: 12 }}>
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <h2 className="eyebrow" id="sum-h-m">
              선택한 좌석
            </h2>
            <p className="t-md fw-b">{hold.seatsText}</p>
            <p className="t-sm muted">{pickSub(view, hold)}</p>
          </div>
          <p className="t-lg num nowrap">{formatWon(hold.amount)}</p>
        </div>
        {view.overLimit ? <LimitError /> : null}
        <HoldWhy view={view} v={v} />
        <HoldButton view={view} links={links} v={v} className="btn btn-primary btn-lg btn-block" />
        <NavButton href={links.leave} className="btn btn-ghost btn-block">
          예매 그만두기
        </NavButton>
      </section>
    );
  if (view.summary === 'empty')
    return (
      <section className="sheet" aria-labelledby="sum-h-m" style={{ gap: 12 }}>
        <span className="sheet-handle" aria-hidden="true" />
        <div className="col" style={{ gap: 2 }}>
          <h2 className="eyebrow" id="sum-h-m">
            선택한 좌석
          </h2>
          <p className="t-md fw-b" id="sum-empty-m">
            좌석을 고르세요
          </p>
          <p className="t-sm muted">
            남은 한도 {hold.perPerson}매(1인 {hold.perPerson}매)
          </p>
        </div>
        <NavButton href={links.checkout} className="btn btn-primary btn-lg btn-block" disabled describedBy="sum-empty-m">
          좌석 홀드하기
        </NavButton>
        <NavButton href={links.leave} className="btn btn-ghost btn-block">
          예매 그만두기
        </NavButton>
      </section>
    );
  if (view.summary === 'hold')
    return (
      <section className="sheet" aria-labelledby="sum-h-m" style={{ gap: 12 }}>
        <span className="sheet-handle" aria-hidden="true" />
        <div className="row between" style={{ alignItems: 'flex-start', gap: 12 }}>
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <h2 className="eyebrow" id="sum-h-m">
              홀드한 좌석
            </h2>
            <p className="t-md fw-b">{hold.seatsText}</p>
            <p className="t-sm muted">
              {hold.grade} {hold.quantity}매
            </p>
          </div>
          <p className="t-lg num nowrap">{formatWon(hold.amount)}</p>
        </div>
        <div className="row between card-flat" style={{ padding: '10px 12px', gap: 10 }}>
          <p className="t-xs muted" id="ext-h-m">
            {extText(view)}
          </p>
          <ExtendButton view={view} links={links} v={v} />
        </div>
        <Link className="btn btn-primary btn-lg btn-block" href={links.checkout}>
          주문·결제로 계속
        </Link>
        <div className="row" style={{ gap: 8 }}>
          <NavButton href={links.release} className="btn btn-ghost grow">
            홀드한 좌석 풀기
          </NavButton>
          <NavButton href={links.leave} className="btn btn-ghost grow">
            예매 그만두기
          </NavButton>
        </div>
      </section>
    );
  return null;
}

/** 태블릿 아래 띠 */
export function SummaryBar({ view, hold, links }: Props) {
  const v: Variant = 't';
  const pad = { padding: '14px 24px 22px', gap: 16 };
  if (view.summary === 'pick')
    return (
      <section className="bottom-bar" aria-labelledby="sum-h-t" style={pad}>
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <h2 className="eyebrow" id="sum-h-t">
            선택한 좌석
          </h2>
          <p className="t-md fw-b">{hold.seatsText}</p>
          <p className="t-sm muted">{pickSub(view, hold)}</p>
          {view.overLimit ? <LimitError /> : null}
          <HoldWhy view={view} v={v} />
        </div>
        <p className="t-xl num nowrap">{formatWon(hold.amount)}</p>
        <NavButton href={links.leave} className="btn btn-ghost">
          예매 그만두기
        </NavButton>
        <HoldButton view={view} links={links} v={v} className="btn btn-primary btn-lg" />
      </section>
    );
  if (view.summary === 'empty')
    return (
      <section className="bottom-bar" aria-labelledby="sum-h-t" style={pad}>
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <h2 className="eyebrow" id="sum-h-t">
            선택한 좌석
          </h2>
          <p className="t-md fw-b" id="sum-empty-t">
            좌석을 고르세요
          </p>
          <p className="t-sm muted">
            남은 한도 {hold.perPerson}매(1인 {hold.perPerson}매)
          </p>
        </div>
        <NavButton href={links.leave} className="btn btn-ghost">
          예매 그만두기
        </NavButton>
        <NavButton href={links.checkout} className="btn btn-primary btn-lg" disabled describedBy="sum-empty-t">
          좌석 홀드하기
        </NavButton>
      </section>
    );
  if (view.summary === 'hold')
    return (
      <section className="bottom-bar" aria-labelledby="sum-h-t" style={pad}>
        <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
          <h2 className="eyebrow" id="sum-h-t">
            홀드한 좌석
          </h2>
          <p className="t-md fw-b">
            {hold.seatsText}{' '}
            <span className="t-sm muted fw-r">
              · {hold.grade} {hold.quantity}매
            </span>
          </p>
          <p className="t-xs muted" id="ext-h-t">
            {extText(view)}
          </p>
        </div>
        <p className="t-xl num nowrap">{formatWon(hold.amount)}</p>
        <div className="col" style={{ gap: 4, alignItems: 'stretch' }}>
          <Link className="btn btn-primary btn-lg" href={links.checkout}>
            주문·결제로 계속
          </Link>
          <div className="row" style={{ gap: 4 }}>
            <NavButton href={links.release} className="btn btn-ghost btn-sm grow">
              홀드한 좌석 풀기
            </NavButton>
            <NavButton href={links.leave} className="btn btn-ghost btn-sm grow">
              예매 그만두기
            </NavButton>
          </div>
        </div>
      </section>
    );
  return null;
}

/** 데스크톱 오른쪽 패널의 요약 카드 */
export function SummaryCard({ view, hold, links }: Props) {
  const v: Variant = 'd';
  if (view.summary === 'pick')
    return (
      <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="sum-h-d">
        <h2 className="eyebrow" id="sum-h-d">
          선택한 좌석
        </h2>
        <p className="t-lg">{hold.seatsText}</p>
        <dl className="kv">
          <dt>등급</dt>
          <dd>
            {hold.grade} {hold.quantity}매
          </dd>
          <dt>구매 한도</dt>
          <dd>{view.overLimit ? `1인 ${hold.perPerson}매` : `남은 한도 ${hold.remaining}매(1인 ${hold.perPerson}매)`}</dd>
        </dl>
        <div className="divider" />
        <div className="row between">
          <span className="fw-b">합계</span>
          <span className="kv-total num">{formatWon(hold.amount)}</span>
        </div>
        {view.overLimit ? <LimitError /> : null}
        <HoldWhy view={view} v={v} />
        <HoldButton view={view} links={links} v={v} className="btn btn-primary btn-lg btn-block" />
        <NavButton href={links.leave} className="btn btn-ghost btn-block">
          예매 그만두기
        </NavButton>
      </section>
    );
  if (view.summary === 'empty')
    return (
      <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="sum-h-d">
        <h2 className="eyebrow" id="sum-h-d">
          선택한 좌석
        </h2>
        <p className="t-lg" id="sum-empty-d">
          좌석을 고르세요
        </p>
        <dl className="kv">
          <dt>구매 한도</dt>
          <dd>
            남은 한도 {hold.perPerson}매(1인 {hold.perPerson}매)
          </dd>
        </dl>
        <NavButton href={links.checkout} className="btn btn-primary btn-lg btn-block" disabled describedBy="sum-empty-d">
          좌석 홀드하기
        </NavButton>
        <NavButton href={links.leave} className="btn btn-ghost btn-block">
          예매 그만두기
        </NavButton>
      </section>
    );
  if (view.summary === 'hold')
    return (
      <section className="card pad-lg col" style={{ gap: 14 }} aria-labelledby="sum-h-d">
        <h2 className="eyebrow" id="sum-h-d">
          홀드한 좌석
        </h2>
        <p className="t-lg">{hold.seatsText}</p>
        <dl className="kv">
          <dt>등급</dt>
          <dd>
            {hold.grade} {hold.quantity}매
          </dd>
        </dl>
        <div className="divider" />
        <div className="row between">
          <span className="fw-b">합계</span>
          <span className="kv-total num">{formatWon(hold.amount)}</span>
        </div>
        <div className="card-flat col" style={{ gap: 8, padding: '12px 14px' }}>
          <div className="row between">
            <span className="t-sm fw-b">홀드 남은 시간</span>
            {holdTimer(view)}
          </div>
          <div className="row between" style={{ gap: 10 }}>
            <p className="t-xs muted" id="ext-h-d">
              {extText(view)}
            </p>
            <ExtendButton view={view} links={links} v={v} />
          </div>
        </div>
        <Link className="btn btn-primary btn-lg btn-block" href={links.checkout}>
          주문·결제로 계속
        </Link>
        <div className="row" style={{ gap: 8 }}>
          <NavButton href={links.release} className="btn btn-ghost grow">
            홀드한 좌석 풀기
          </NavButton>
          <NavButton href={links.leave} className="btn btn-ghost grow">
            예매 그만두기
          </NavButton>
        </div>
      </section>
    );
  return null;
}
