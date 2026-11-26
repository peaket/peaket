// F-04-17 교차 필터·요약·기준선. 정본: docs/features/forensic-replay.md §2.1·§3.5, d5 §7.17.
// 차원 체크는 비트마스크 요약으로 이어지고, 같은 값을 표로도 보인다.
import { useMemo, useState } from 'react';
import { EVENT_KIND, RESULT, type EventColumns, type ForensicSource } from '../lib/forensics/events.ts';
import { summarize, type ReplayFilter, type ReplaySummary } from '../lib/replay/crossfilter.ts';
import type { ReplayBounds } from '../lib/replay/session.ts';
import { baselineRows, stageBands, summaryRows, type BaselineRow, type StageBand, type TableRow } from '../lib/replay/table.ts';
import { ReplayTable } from './ReplayTable';

const RESULT_LABEL: Record<number, string> = {
  [RESULT.NONE]: '없음',
  [RESULT.HELD]: 'HELD',
  [RESULT.CONFLICT]: 'CONFLICT',
  [RESULT.LIMIT]: 'LIMIT',
  [RESULT.ERROR]: 'ERROR',
  [RESULT.PAID]: 'PAID',
  [RESULT.FAILED]: 'FAILED',
};

const KIND_LABEL: Record<number, string> = {
  [EVENT_KIND.ADMIT]: '입장 확정',
  [EVENT_KIND.HOLD_TRY]: '홀드 시도',
  [EVENT_KIND.HOLD_END]: '홀드 끝',
  [EVENT_KIND.PAY_TRY]: '결제 시도',
  [EVENT_KIND.SALE]: '판매',
  [EVENT_KIND.PAY_FAIL]: '결제 실패',
  [EVENT_KIND.QUEUE_ENTER]: '대기열 진입',
};

function unique(values: Uint8Array | Uint16Array | Uint32Array, keep: Uint8Array): number[] {
  const out = new Set<number>();
  for (let i = 0; i < values.length; i += 1) if (keep[i] === 1) out.add(values[i]);
  return [...out].sort((a, b) => a - b);
}

function toggled(current: readonly number[], value: number): number[] {
  return current.includes(value) ? current.filter((x) => x !== value) : [...current, value];
}

function CheckGroup({
  title,
  values,
  selected,
  label,
  onToggle,
}: {
  title: string;
  values: readonly number[];
  selected: readonly number[];
  label: (value: number) => string;
  onToggle: (value: number) => void;
}) {
  return (
    <fieldset className="col" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}>
      <legend className="t-xs muted">{title}</legend>
      {values.map((value) => (
        <label key={value} className="row t-sm" style={{ gap: 6 }}>
          <input type="checkbox" checked={selected.includes(value)} onChange={() => onToggle(value)} />
          {label(value)}
        </label>
      ))}
    </fieldset>
  );
}

export function ReplayFilters({
  columns,
  keep,
  source,
  bounds,
}: {
  columns: EventColumns;
  keep: Uint8Array;
  source: ForensicSource;
  bounds: ReplayBounds;
}) {
  const [sections, setSections] = useState<number[]>([]);
  const [results, setResults] = useState<number[]>([]);
  const [kinds, setKinds] = useState<number[]>([]);
  const [botTiers, setBotTiers] = useState<number[]>([]);
  const [netTypes, setNetTypes] = useState<number[]>([]);
  const [deviceGroups, setDeviceGroups] = useState<number[]>([]);
  const [member, setMember] = useState<0 | 1 | undefined>(undefined);

  const filter = useMemo<ReplayFilter>(() => {
    const out: ReplayFilter = { fromMs: bounds.fromMs, toMs: bounds.toMs };
    if (sections.length) out.sections = sections;
    if (results.length) out.results = results;
    if (kinds.length) out.kinds = kinds;
    if (botTiers.length) out.botTiers = botTiers;
    if (netTypes.length) out.netTypes = netTypes;
    if (deviceGroups.length) out.deviceGroups = deviceGroups;
    if (member !== undefined) out.member = member;
    return out;
  }, [bounds, sections, results, kinds, botTiers, netTypes, deviceGroups, member]);

  const summary: ReplaySummary = useMemo(() => summarize(columns, keep, filter), [columns, keep, filter]);
  const summaryTable: TableRow[] = useMemo(() => summaryRows(summary, source), [summary, source]);
  const bands: StageBand[] = useMemo(() => stageBands(columns, keep, 0), [columns, keep]);
  const baseline: BaselineRow[] = useMemo(() => baselineRows(bands), [bands]);

  const sectionValues = useMemo(() => unique(columns.section, keep), [columns, keep]);
  const resultValues = useMemo(() => unique(columns.result, keep), [columns, keep]);
  const kindValues = useMemo(() => unique(columns.kind, keep), [columns, keep]);
  const botValues = useMemo(() => unique(columns.bot_tier, keep), [columns, keep]);
  const netValues = useMemo(() => unique(columns.net_type, keep), [columns, keep]);
  const deviceValues = useMemo(() => unique(columns.device_group, keep), [columns, keep]);

  return (
    <aside className="col" style={{ gap: 16, minWidth: 0 }} aria-label="교차 필터와 후보 요약">
      <section className="widget" aria-labelledby="fx-filter-h">
        <div className="widget-head">
          <h2 className="t-sm fw-b" id="fx-filter-h">
            교차 필터
          </h2>
        </div>
        <div className="widget-body col" style={{ gap: 12 }}>
          <CheckGroup title="구역" values={sectionValues} selected={sections} label={(v) => `구역 ${v}`} onToggle={(v) => setSections(toggled(sections, v))} />
          <CheckGroup title="결과" values={resultValues} selected={results} label={(v) => RESULT_LABEL[v] ?? String(v)} onToggle={(v) => setResults(toggled(results, v))} />
          <CheckGroup title="사건 종류" values={kindValues} selected={kinds} label={(v) => KIND_LABEL[v] ?? String(v)} onToggle={(v) => setKinds(toggled(kinds, v))} />
          {source === 'SYNTHETIC' || source === 'RESEARCH' ? (
            <CheckGroup title="봇 등급" values={botValues} selected={botTiers} label={(v) => `등급 ${v}`} onToggle={(v) => setBotTiers(toggled(botTiers, v))} />
          ) : null}
          {source === 'SYNTHETIC' ? (
            <>
              <CheckGroup title="네트워크 유형" values={netValues} selected={netTypes} label={(v) => `유형 ${v}`} onToggle={(v) => setNetTypes(toggled(netTypes, v))} />
              <CheckGroup title="기기 묶음" values={deviceValues} selected={deviceGroups} label={(v) => `기기 ${v}`} onToggle={(v) => setDeviceGroups(toggled(deviceGroups, v))} />
            </>
          ) : null}
          {source === 'INVESTIGATION' ? (
            <fieldset className="col" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}>
              <legend className="t-xs muted">묶음</legend>
              {[0, 1].map((value) => (
                <label key={value} className="row t-sm" style={{ gap: 6 }}>
                  <input type="radio" name="fx-member" checked={member === value} onChange={() => setMember(value as 0 | 1)} />
                  {value === 1 ? '묶음 계정' : '나머지'}
                </label>
              ))}
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setMember(undefined)}>
                묶음 조건 지우기
              </button>
            </fieldset>
          ) : null}
        </div>
      </section>

      <section className="widget" aria-labelledby="fx-summary-h">
        <div className="widget-head">
          <h2 className="t-sm fw-b" id="fx-summary-h">
            고른 범위 요약
          </h2>
        </div>
        <div className="widget-body">
          <ReplayTable
            caption="고른 범위 요약(표로 보기)"
            columns={[
              { key: 'label', label: '항목', value: (row: TableRow) => row.label },
              { key: 'value', label: '값', value: (row: TableRow) => row.value },
            ]}
            rows={summaryTable}
          />
        </div>
      </section>

      <section className="widget" aria-labelledby="fx-baseline-h">
        <div className="widget-head">
          <h2 className="t-sm fw-b" id="fx-baseline-h">
            단계별 시간 대 정상 기준선
          </h2>
        </div>
        <div className="widget-body col" style={{ gap: 8 }}>
          <p className="t-xs muted">후보 찾기용입니다. 조치는 사건 작업대에서 소명과 승인을 거쳐 합니다(POL-046).</p>
          <ReplayTable
            caption="단계별 시간 대 정상 기준선(표로 보기)"
            columns={[
              { key: 'stage', label: '단계', value: (row: BaselineRow) => row.stage },
              { key: 'p1', label: '1%', value: (row: BaselineRow) => row.p1 },
              { key: 'p50', label: '50%', value: (row: BaselineRow) => row.p50 },
              { key: 'p99', label: '99%', value: (row: BaselineRow) => row.p99 },
              { key: 'n', label: '여정', value: (row: BaselineRow) => row.n },
            ]}
            rows={baseline}
          />
        </div>
      </section>
    </aside>
  );
}
