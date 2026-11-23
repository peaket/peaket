// 포화도 요약(F-03-3 OPS-380, 위젯 키 ops-saturation.summary, C-T30 ①, d5 §7.2 '포화도 요약(CPU·Redis 메모리·Kafka lag·이벤트 루프, <정상>|<주의>|<위험>)').
// 상태는 색만이 아니라 글자로 보인다(WCAG 1.4.1). 값이 없는 칸은 '받지 못함'이고 요약을 정상으로 만들지 않는다(서버가 정한 level을 그대로 그린다).
import type { TimeRange } from '@/shared/lib/links';
import { fmt, isUnavailable, LiveFrame, NotReceived } from './frame';

export type SaturationLevel = 'ok' | 'warn' | 'danger' | 'unknown';
export interface SaturationField {
  value: number | null;
  level: SaturationLevel;
}
export interface SaturationValue {
  widgetKey: 'ops-saturation.summary';
  source: string;
  at: string;
  eventId: string | null;
  level: SaturationLevel;
  cpu: SaturationField;
  redisMemory: SaturationField;
  kafkaLag: SaturationField;
  eventLoop: SaturationField;
}

const LEVEL_TEXT: Record<SaturationLevel, string> = { ok: '정상', warn: '주의', danger: '위험', unknown: '받지 못함' };
const LEVEL_CLASS: Record<SaturationLevel, string> = { ok: 'slo slo-ok', warn: 'slo slo-burning', danger: 'slo slo-breached', unknown: 'slo slo-stale' };

export function LevelBadge({ level }: { level: SaturationLevel }) {
  return <span className={LEVEL_CLASS[level] ?? 'slo slo-stale'}>{LEVEL_TEXT[level] ?? '받지 못함'}</span>;
}

const ROWS: { key: 'cpu' | 'redisMemory' | 'kafkaLag' | 'eventLoop'; label: string; show: (v: number) => string }[] = [
  { key: 'cpu', label: '핫패스 CPU', show: (v) => `${fmt(v * 100)}%` },
  { key: 'redisMemory', label: 'Redis 메모리', show: (v) => `${fmt(v * 100)}%` },
  { key: 'kafkaLag', label: 'Kafka 밀림', show: (v) => `${fmt(v)}건` },
  { key: 'eventLoop', label: '이벤트 루프 p99', show: (v) => `${fmt(v * 1000, 1)}ms` },
];

export function SaturationWidget({ value, range, id = 'w-live-sat', loading }: { value: SaturationValue | { error: 'source-unavailable'; eventId: string | null } | undefined; range: TimeRange; id?: string; loading?: boolean }) {
  const v = value && !isUnavailable(value) && 'cpu' in value ? value : null;
  return (
    <LiveFrame id={id} title="포화도 요약" widgetKey="ops-saturation.summary" panel="saturation" eventId={value?.eventId ?? null} range={range} status={loading ? undefined : v ? <LevelBadge level={v.level} /> : <NotReceived />}>
      {loading ? (
        <p className="t-xs muted" role="status">불러오는 중입니다…</p>
      ) : v ? (
        <ul className="col t-xs" style={{ gap: 6 }}>
          {ROWS.map((r) => {
            const f = v[r.key];
            return (
              <li key={r.key} className="row between" style={{ gap: 8 }}>
                <span className={f.level === 'warn' || f.level === 'danger' ? 'fw-b' : undefined}>{r.label}</span>
                <span className="row" style={{ gap: 8 }}>
                  <span className="num">{f.value === null ? '—' : r.show(f.value)}</span>
                  <LevelBadge level={f.value === null ? 'unknown' : f.level} />
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="t-xs muted">포화도 지표를 받지 못했습니다.</p>
      )}
    </LiveFrame>
  );
}
