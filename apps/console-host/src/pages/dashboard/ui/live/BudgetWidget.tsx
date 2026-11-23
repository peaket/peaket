// 여정별 남은 허용 실패·소진 배수(F-03-3 OPS-380, 위젯 키 ops-budget.journeys, docs/features/control-tower.md §2·§6의 3, d5 §7.2, ADR-0049·0126).
// "결제 확정 12건 중 3건 사용" 꼴로 그리고, 기록 규칙 시계열이 없는 여정은 0이 아니라 '받지 못함'이다. 입장 목표에 묶인 네 여정은 배지로 보인다.
import type { TimeRange } from '@/shared/lib/links';
import { fmt, isUnavailable, LiveFrame, NotReceived } from './frame';

/** 여정 일곱의 글(asyncapi OpsAlert.journey) */
export const JOURNEY_LABEL: Record<string, string> = {
  detail: '공연 상세',
  queue_entry: '대기열 진입',
  queue_state: '대기 상태 전파',
  hold: '좌석 홀드',
  seat_status: '좌석 상태 전파',
  payment_accept: '결제 접수',
  payment_confirm: '결제 확정',
};

export interface BudgetJourney {
  journey: string;
  linked: boolean;
  allowed: number | null;
  used: number | null;
  remaining: number | null;
  burnShort?: number | null;
  burnLong?: number | null;
  reason?: string;
}

export interface BudgetValue {
  widgetKey: 'ops-budget.journeys';
  source: string;
  at: string;
  eventId: string | null;
  journeys: BudgetJourney[];
}

const TITLE = '여정별 남은 허용 실패·소진 배수';

function Row({ j }: { j: BudgetJourney }) {
  const label = JOURNEY_LABEL[j.journey] ?? j.journey;
  if (j.allowed === null || j.used === null) {
    return (
      <li className="row between t-xs" style={{ gap: 8 }}>
        <span>{label}</span>
        <NotReceived />
      </li>
    );
  }
  const pct = j.allowed > 0 ? Math.min(100, Math.round((j.used / j.allowed) * 100)) : 100;
  const remaining = j.remaining ?? Math.max(0, j.allowed - j.used);
  const burn = typeof j.burnShort === 'number' ? j.burnShort : null;
  const tone = burn !== null && burn >= 10 ? 'slo slo-breached' : burn !== null && burn >= 3 ? 'slo slo-burning' : 'slo slo-ok';
  return (
    <li className="col" style={{ gap: 4 }}>
      <div className="row between t-xs" style={{ gap: 8 }}>
        <span className="fw-b">
          {`${label} ${fmt(j.allowed)}건 중 ${fmt(j.used)}건 사용`}
          {j.linked ? (
            <>
              {' '}
              <span className="badge badge-outline">입장 목표 연동</span>
            </>
          ) : null}
        </span>
        <span className="row" style={{ gap: 8 }}>
          {burn !== null ? <span className="num">{`소진 ${fmt(burn, 1)}배`}</span> : null}
          <span className={tone}>{`남음 ${fmt(remaining)}건`}</span>
        </span>
      </div>
      <div className="progress" role="progressbar" aria-label={`${label} 허용 실패 ${pct}% 사용`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}

export function BudgetWidget({ value, range, id = 'w-live-budget', loading }: { value: BudgetValue | { error: 'source-unavailable'; eventId: string | null } | undefined; range: TimeRange; id?: string; loading?: boolean }) {
  const eventId = value?.eventId ?? null;
  const journeys = value && !isUnavailable(value) && 'journeys' in value ? value.journeys : null;
  return (
    <LiveFrame id={id} title={TITLE} widgetKey="ops-budget.journeys" panel="budget" eventId={eventId} range={range}>
      {loading ? (
        <p className="t-xs muted" role="status">불러오는 중입니다…</p>
      ) : journeys ? (
        <ul className="col" style={{ gap: 9 }}>
          {[...journeys]
            .sort((a, b) => Number(b.linked) - Number(a.linked))
            .map((j) => (
              <Row key={j.journey} j={j} />
            ))}
        </ul>
      ) : (
        <p className="t-xs muted">
          <NotReceived /> 기록 규칙 값을 받지 못했습니다(0으로 보지 않습니다).
        </p>
      )}
    </LiveFrame>
  );
}
