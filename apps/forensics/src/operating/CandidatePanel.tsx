// F-04-18 후보 패널. 정본: docs/features/forensic-replay.md §2.1~§2.3, d5 §7.17.
// 합성은 산점도, 연구는 한 축 분포, 조사는 단계별 기준선을 그리고, 같은 모델에서 표를 만든다.
import { useMemo, useState } from 'react';
import type { EventColumns, ForensicSource } from '../lib/forensics/events.ts';
import {
  candidateNotice,
  candidatePanelKind,
  candidateTableRows,
  histogramRows,
  maskToKeep,
  panelSections,
  precisionNotice,
  seatsOfSessions,
  selectPoints,
  selectionStats,
  sessionPoints,
  type PointBounds,
  type SelectionStats,
} from '../lib/replay/candidate.ts';
import { selectionMask, type ReplayFilter } from '../lib/replay/crossfilter.ts';
import type { ReplayBounds } from '../lib/replay/session.ts';
import { DistributionPlot } from './DistributionPlot';
import { ReplayTable } from './ReplayTable';
import { ScatterPlot } from './ScatterPlot';
import { StepBaseline } from './StepBaseline';
import { useCandidateWorker } from './useCandidateWorker';

export function CandidatePanel({
  columns,
  keep,
  source,
  bounds,
  filter,
  onHighlight,
}: {
  columns: EventColumns;
  keep: Uint8Array;
  source: ForensicSource;
  bounds: ReplayBounds;
  filter?: ReplayFilter;
  onHighlight: (seats: readonly number[]) => void;
}) {
  const sections = panelSections(source);
  const kind = candidatePanelKind(source);
  const candidateKeep = useMemo(
    () =>
      maskToKeep(
        selectionMask(columns, keep, filter ?? { fromMs: bounds.fromMs, toMs: bounds.toMs }),
        columns.t_ms.length,
      ),
    [columns, keep, filter, bounds],
  );
  const sessions = useMemo(() => sessionPoints(columns, candidateKeep), [columns, candidateKeep]);
  const model = useCandidateWorker(columns, candidateKeep, source);
  const [selection, setSelection] = useState<PointBounds | null>(null);
  const [showTable, setShowTable] = useState(true);

  const stats: SelectionStats | null = useMemo(
    () => (selection === null ? null : selectionStats(model.points, selection, model.totalBots)),
    [model, selection],
  );

  const selectSessions = (list: readonly number[]): void => {
    onHighlight(seatsOfSessions(columns, candidateKeep, new Set(list)));
  };

  const clear = (): void => {
    setSelection(null);
    onHighlight([]);
  };

  const title =
    kind === 'scatter' ? '봇 후보' : kind === 'distribution' ? '후보 분포' : '단계별 시간 대 정상 기준선';
  const summaryRows = candidateTableRows(model, stats ?? undefined);
  const distributionRows = model.histogram === null ? [] : histogramRows(model.histogram);

  return (
    <section className="widget" aria-labelledby="fx-cand-h">
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b" id="fx-cand-h">
          {title}
        </h2>
        <div className="actions">
          <button className="btn btn-text btn-sm" type="button" onClick={() => setShowTable((value) => !value)}>
            표로 보기
          </button>
          <button className="btn btn-text btn-sm" type="button" onClick={clear}>
            고르기 지우기
          </button>
        </div>
      </div>
      <div className="widget-body col" style={{ gap: 8 }}>
        {sections.precision ? (
          <ScatterPlot
            points={model.points}
            onSelect={(next) => {
              setSelection(next);
              if (next === null) onHighlight([]);
              else selectSessions(selectPoints(model.points, next).map((point) => point.session));
            }}
          />
        ) : null}
        {sections.histogram && model.histogram !== null ? (
          <DistributionPlot
            histogram={model.histogram}
            onSelect={(fromMs, toMs) => {
              const chosen = sessions
                .filter((session) => session.firstHoldMs >= fromMs && session.firstHoldMs < toMs)
                .map((session) => session.session);
              selectSessions(chosen);
            }}
          />
        ) : null}
        {sections.baseline ? (
          <StepBaseline columns={columns} keep={candidateKeep} onSelectSessions={selectSessions} />
        ) : null}
        {sections.precision ? (
          <p className="t-xs muted">가로: 입장 확정 → 첫 홀드 시도(ms, 로그 눈금) · 세로: 포인터 이동 엔트로피</p>
        ) : null}
        <p className="t-xs muted">{candidateNotice(source)}</p>
        {sections.precision ? (
          <p className="t-xs tx-warning" role="note">
            {precisionNotice()}
          </p>
        ) : null}
        {sections.precision && stats !== null ? (
          <p className="t-xs muted">
            고른 세션 {stats.sessions.toLocaleString('ko-KR')} · 정밀도 {stats.precision.toFixed(2)} · 재현율{' '}
            {stats.recall.toFixed(2)}
          </p>
        ) : null}
        {sections.deviceGroups && model.bursts.length > 0 ? (
          <ul className="col t-xs" style={{ gap: 2, margin: 0, padding: 0, listStyle: 'none' }}>
            {model.bursts.map((burst) => (
              <li key={burst.deviceGroup}>
                기기 묶음 #{burst.deviceGroup} · 세션 {burst.sessions} · 동시 시도 {burst.attempts}
              </li>
            ))}
          </ul>
        ) : null}
        {showTable ? (
          <ReplayTable
            caption="후보 요약(표로 보기)"
            columns={[
              { key: 'label', label: '항목', value: (row: { label: string; value: number | string }) => row.label },
              { key: 'value', label: '값', value: (row: { label: string; value: number | string }) => row.value },
            ]}
            rows={summaryRows}
          />
        ) : null}
        {showTable && model.histogram !== null ? (
          <ReplayTable
            caption="연구 분포(표로 보기)"
            columns={[
              { key: 'from', label: '시작', value: (row: { fromMs: number }) => row.fromMs },
              { key: 'to', label: '끝', value: (row: { toMs: number }) => row.toMs },
              { key: 'sessions', label: '세션', value: (row: { sessions: number }) => row.sessions },
            ]}
            rows={distributionRows}
          />
        ) : null}
      </div>
    </section>
  );
}
