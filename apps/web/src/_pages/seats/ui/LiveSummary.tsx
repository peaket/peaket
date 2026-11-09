// 좌석 선택 요약(CMP-025 자리, d5 §5.10 ③⑥⑨). 고른 좌석·금액·남은 한도와 [좌석 홀드하기]·[예매 그만두기]를 화면 아래 띠로 보인다.
// 데스크톱 오른쪽 패널은 아직 없다(같은 띠를 쓴다).
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { BookingNotice, SeatPick } from '../model/booking-machine';

const won = (n: number): string => `₩${n.toLocaleString('ko-KR')}`;

export interface SummaryProps {
  picks: SeatPick[];
  /** 등급 ID → 가격 */
  prices: ReadonlyMap<string, number>;
  limit: number;
  phase: 'selecting' | 'holding' | 'held' | 'paused' | 'saleEnded';
  notice: BookingNotice | null;
  /** 홀드한 좌석(서버가 준 이름·금액) */
  held: { labels: string[]; total: number } | null;
  checkoutHref: string;
  /** 홀드 남은 시간이 1분 이하다(한 번 낭독한다, d5 §5.10 '1분 전') */
  oneMinute: boolean;
  onHold(): void;
  onLeave(): void;
  /** 1회 연장을 이미 썼다 */
  extended: boolean;
  onExtend(): void;
  onRelease(): void;
}

export function noticeText(n: BookingNotice, limit: number): string {
  switch (n.kind) {
    case 'lost':
      return n.suggested.length > 0 ? `이 좌석은 방금 다른 분이 선택했습니다. 가까운 좌석: ${n.suggested.join(', ')}` : '이 좌석은 방금 다른 분이 선택했습니다';
    case 'recent':
      return n.availableAt ? `방금 놓은 좌석은 ${Math.max(1, Math.ceil((Date.parse(n.availableAt) - Date.now()) / 1000))}초 뒤에 다시 고를 수 있습니다` : '방금 놓은 좌석은 잠시 뒤에 다시 고를 수 있습니다';
    case 'limit':
      return `한 공연에서 최대 ${limit}매까지 구매할 수 있습니다`;
    case 'expired':
      return '홀드 시간이 끝나 좌석이 풀렸습니다. 요금은 청구되지 않습니다';
    case 'released':
      return '좌석을 놓았습니다. 방금 놓은 좌석은 30초 뒤에 다시 고를 수 있습니다';
    case 'in-payment':
      return '결제가 진행 중이라 좌석을 놓거나 시간을 늘릴 수 없습니다';
    case 'recent-pick':
      return `방금 놓은 좌석은 ${Math.max(1, Math.ceil((n.until - Date.now()) / 1000))}초 뒤에 다시 고를 수 있습니다`;
    default:
      return '요청을 처리하지 못했습니다. 다시 시도해 주세요';
  }
}

export function LiveSummary({ picks, prices, limit, phase, notice, held, checkoutHref, oneMinute, onHold, onLeave, extended, onExtend, onRelease }: SummaryProps) {
  const payRef = useRef<HTMLAnchorElement>(null);
  // 홀드가 되면 초점을 [결제하기]로 옮긴다(누른 버튼이 사라져 키보드 사용자가 초점을 잃지 않게)
  useEffect(() => {
    if (phase === 'held') payRef.current?.focus();
  }, [phase]);
  const total = held?.total ?? picks.reduce((n, p) => n + (p.tier ? (prices.get(p.tier) ?? 0) : 0), 0);
  const labels = held?.labels ?? picks.map((p) => p.label);
  const left = Math.max(0, limit - picks.length);
  const blocked = phase === 'paused' ? '판매가 잠시 멈춰 좌석을 잡을 수 없습니다' : phase === 'saleEnded' ? '판매 시간이 끝났습니다' : null;
  const message = notice ? noticeText(notice, limit) : '';
  // 낭독 영역은 미리 두고 글만 바꾼다(글과 함께 새로 끼워 넣으면 읽히지 않을 수 있다)
  const status = notice && notice.kind !== 'limit' ? message : phase === 'held' ? (oneMinute ? '홀드 남은 시간이 1분입니다' : '좌석을 잡았습니다. 시간 안에 결제해 주세요') : '';
  return (
    <div className="card pad col" style={{ gap: 8, borderRadius: 0 }}>
      <p className="sr-only" role="status">
        {status}
      </p>
      <p className="sr-only" role="alert">
        {notice?.kind === 'limit' ? message : ''}
      </p>
      {notice ? <p className={notice.kind === 'limit' ? 'error-msg' : 't-sm'}>{message}</p> : null}
      <div className="row wrap between" style={{ gap: 8 }}>
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          {labels.length > 0 ? (
            <>
              <strong className="t-sm">{labels.join(', ')}</strong>
              <span className="t-sm muted num">
                {total > 0 ? `${won(total)} · ` : ''}
                {held ? `${labels.length}매 홀드` : notice?.kind === 'limit' ? `1인 ${limit}매` : `남은 한도 ${left}매`}
              </span>
            </>
          ) : (
            <span className="t-sm muted">좌석을 골라 주세요</span>
          )}
          {blocked ? (
            <span className="t-xs muted" id="seat-hold-why">
              {blocked}
            </span>
          ) : null}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-text btn-sm" type="button" onClick={onLeave}>
            예매 그만두기
          </button>
          {phase === 'held' ? (
            <>
              <button className="btn btn-ghost btn-sm" type="button" onClick={onRelease}>
                좌석 놓기
              </button>
              {/* 연장 뒤에도 초점을 잃지 않게 disabled 대신 aria-disabled로 막는다 */}
              <button className="btn btn-outline btn-sm" type="button" aria-disabled={extended} onClick={extended ? undefined : onExtend}>
                {extended ? '이미 연장했습니다' : '1회 연장'}
              </button>
            </>
          ) : null}
          {phase === 'held' ? (
            <Link ref={payRef} className="btn btn-primary" href={checkoutHref}>
              결제하기
            </Link>
          ) : (
            <button
              className="btn btn-primary"
              type="button"
              // 누르는 중에도 초점을 잃지 않게 disabled 대신 aria-disabled로 막는다(onHold가 상태를 다시 본다)
              disabled={picks.length === 0 || Boolean(blocked)}
              aria-disabled={phase !== 'selecting'}
              aria-busy={phase === 'holding'}
              aria-describedby={blocked ? 'seat-hold-why' : undefined}
              onClick={onHold}
            >
              {phase === 'holding' ? '좌석을 잡는 중' : '좌석 홀드하기'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
