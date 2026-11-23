// 관제 실시간 표 시작 조립(OPS-160, F-04-1, docs/streaming.md §4.3·§4.5). main.ts가 부른다.
// - PEAKET_RT_CLICKHOUSE_URL·_USER(기본 an_rt_reader)·_PASSWORD: rt 뷰와 회차 기준 자료를 읽는 ClickHouse. 주소가 없으면 닫힌 원천으로 시작한다
//   (파트너 판매 현황 503 dependency-unavailable, 신선도 모름 → 3분 뒤 Degraded).
// - PEAKET_RT_PULSE_PARTITIONS: 기대 파티션 '토픽:파티션 수'를 쉼표로(예 telemetry.queue:3,telemetry.purchase:3,telemetry.trust-verdicts:3).
//   없으면 뷰에 보이는 파티션만 보고(빠진 파티션을 못 잡는다) 경고한다. 텔레메트리 셋 밖의 토픽이나 틀린 꼴은 시작 실패다.
// - 소속 확인은 회차 취소와 같은 core 판매 설정 클라이언트(HttpCoreEventOwners)를 넘겨받는다.
import { ClickHouseRtSource, PromRtSignals, RtBoard, TELEMETRY_TOPICS, UnavailableRtSource } from './modules/realtime-table/index.js';
import type { EventOwners, PartitionRef, RealtimeTableModuleDeps, RtBoardLog } from './modules/realtime-table/index.js';

export interface RealtimeTableWiring {
  readonly deps: RealtimeTableModuleDeps;
  readonly signals: PromRtSignals;
  readonly warnings: readonly string[];
}

const has = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** '토픽:파티션 수' 목록을 파티션마다 하나로 편다. 틀리면 던진다(조용히 빈 목록으로 두지 않는다) */
export function pulsePartitionsOf(raw: string): PartitionRef[] {
  const out: PartitionRef[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const m = /^([a-z][a-z0-9.-]*):([1-9][0-9]{0,3})$/.exec(part);
    if (!m) throw new Error(`PEAKET_RT_PULSE_PARTITIONS의 꼴이 틀렸다(토픽:파티션 수): ${part}`);
    const topic = m[1]!;
    if (!(TELEMETRY_TOPICS as readonly string[]).includes(topic)) throw new Error(`PEAKET_RT_PULSE_PARTITIONS는 텔레메트리 셋(${TELEMETRY_TOPICS.join('·')})만 받는다: ${topic}`);
    if (seen.has(topic)) throw new Error(`PEAKET_RT_PULSE_PARTITIONS에 같은 토픽이 두 번 있다: ${topic}`);
    seen.add(topic);
    for (let p = 0; p < Number(m[2]); p += 1) out.push({ topic, partition: p });
  }
  return out;
}

export function realtimeTableFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  o: { readonly owners?: EventOwners; readonly log?: RtBoardLog; readonly now?: () => number } = {},
): RealtimeTableWiring {
  const warnings: string[] = [];
  const signals = new PromRtSignals();
  const url = env.PEAKET_RT_CLICKHOUSE_URL;
  const source = has(url)
    ? new ClickHouseRtSource({
        baseUrl: url,
        ...(has(env.PEAKET_RT_CLICKHOUSE_USER) ? { user: env.PEAKET_RT_CLICKHOUSE_USER } : {}),
        ...(has(env.PEAKET_RT_CLICKHOUSE_PASSWORD) ? { password: env.PEAKET_RT_CLICKHOUSE_PASSWORD } : {}),
      })
    : new UnavailableRtSource();
  if (!has(url)) warnings.push('PEAKET_RT_CLICKHOUSE_URL이 없어 관제 실시간 표를 읽지 못한다(파트너 판매 현황 503 dependency-unavailable, 신선도 모름)');
  const rawPartitions = env.PEAKET_RT_PULSE_PARTITIONS;
  const expected = has(rawPartitions) ? pulsePartitionsOf(rawPartitions) : [];
  if (has(url) && expected.length === 0) warnings.push('PEAKET_RT_PULSE_PARTITIONS가 없어 뷰에 보이는 파티션만으로 신선도를 잰다(심장 박동이 빠진 파티션을 잡지 못한다)');
  if (!o.owners) warnings.push('PEAKET_CORE_HTTP_URL이 없어 파트너 판매 현황이 503 authz-unavailable이다');
  const board = new RtBoard({
    source,
    seatMaps: source,
    now: o.now ?? (() => Date.now()),
    monotonicMs: () => performance.now(),
    expected,
    signals,
    ...(o.log ? { log: o.log } : {}),
  });
  return { deps: { board, ...(o.owners ? { owners: o.owners } : {}) }, signals, warnings };
}
