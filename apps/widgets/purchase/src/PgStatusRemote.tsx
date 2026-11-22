// 원격 위젯 '결제사'(Module Federation 노출, ADR-0100 결정 6, ADR-0360). 호스트가 넘긴 ConsoleServices로만 값을 받는다:
// 처음에 위젯 조회(REST)로 그리고, 위젯 흐름(SSE)의 값으로 바꾼다. 원천을 못 읽으면 '받지 못함'을 그린다. 상태는 이 자리 안에만 둔다.
// 접힘(collapsed)이면 머리 한 줄만 그리고 구독은 그대로 둔다(핵심 숫자가 계속 바뀐다, ADR-0091 결정 3). 접기 손잡이는 호스트가 맡는다(onCollapsedChange).
import { useEffect, useState } from 'react';
import type { WidgetKey, WidgetProps } from '@peaket/console-contract';
import { PgStatusWidget } from './PgStatusWidget';
import { PG_STATUS_KEY, freshnessOf, isUnavailable, pgStatusTextOf, type PgStatusValue } from './pg-status-value';
import { Loading, Unavailable } from './Unavailable';

const GRAFANA = 'https://grafana.ops.peaket.example/d/onsale';

export default function PgStatusRemote({ eventId, collapsed, services, onStatus, onCollapsedChange }: WidgetProps) {
  const [value, setValue] = useState<PgStatusValue | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const key = PG_STATUS_KEY as WidgetKey;
    services.data
      .query<PgStatusValue>(key, { eventId })
      .then((v) => {
        if (alive) setValue(v);
      })
      .catch((e: unknown) => services.telemetry.error(e));
    const stop = services.data.subscribe<PgStatusValue>(key, { eventId }, (v) => {
      if (alive) setValue(v);
    });
    return () => {
      alive = false;
      stop();
    };
  }, [eventId, services]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const at = value?.at;
  useEffect(() => {
    if (at) onStatus({ freshnessMs: Math.max(0, now - Date.parse(at)), source: 'prometheus' });
  }, [at, now, onStatus]);
  if (!value) return <Loading title="결제사" />;
  if (isUnavailable(value)) return <Unavailable title="결제사" detailHref={GRAFANA} at={value.at} />;
  return <PgStatusWidget data={pgStatusTextOf(value)} detailHref={GRAFANA} freshness={freshnessOf(value.at, now)} collapsed={collapsed} {...(onCollapsedChange ? { onCollapsedChange } : {})} />;
}
