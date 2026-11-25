// SCR-031 감사 로그·인시던트 리플레이 연결 화면(/audit, d5 §7.4, F-03-7).
// - 감사 행의 원천은 명령 원장(GET /v1/ops/commands)이다. 감사 원장 행 조회 경로는 아직 계약에 없어(계획 1-1, 남은 위험 1)
//   명령 원장을 쓰고, 명단 다운로드 기록·원본 로그 내보내기는 '원천 연결 전'으로 둔다.
// - 체인은 체크포인트 목록·검증(GET /v1/ops/audit-checkpoints*)으로, 내보내기는 commander의 검증 묶음 경로로만 한다.
// - 역할은 서버 세션(GET /v1/ops/auth/sessions/me)에서 읽고, viewer는 상세를 부르지 않는다. 위 상태 바는 덮지 않는다(계획 1-1).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ensureConsoleApi } from '@/shared/api';
import { useLayout } from '@/shared/lib/layout';
import {
  auditRowsOf,
  chainViewOf,
  exportAvailability,
  filterAuditRows,
  replayTimelineOf,
  type AuditActorFilter,
  type AuditRow,
  type ChainView,
  type RawAuditCommand,
  type RawCheckpoint,
} from '../model/audit';
import { AuditTable } from './connected/AuditTable';
import { ChainBanner } from './connected/ChainBanner';
import { ExportBundleDialog } from './connected/ExportBundleDialog';
import { ReplayPlayer } from './connected/ReplayPlayer';

type Load = { kind: 'loading' } | { kind: 'ready' } | { kind: 'config' } | { kind: 'error'; message: string };
type Tab = 'log' | 'downloads';
type PeriodKey = '1h' | '24h' | '7d' | 'all';
const HOUR = 60 * 60_000;
const PERIODS: readonly { key: PeriodKey; label: string; ms: number | null }[] = [
  { key: '1h', label: '최근 1시간', ms: HOUR },
  { key: '24h', label: '최근 24시간', ms: 24 * HOUR },
  { key: '7d', label: '최근 7일', ms: 7 * 24 * HOUR },
  { key: 'all', label: '전체', ms: null },
];
const ACTORS: readonly { key: AuditActorFilter; label: string }[] = [
  { key: 'ALL', label: '모든 행위자' },
  { key: 'HUMAN', label: '사람' },
  { key: 'SYSTEM', label: 'SYSTEM' },
  { key: 'RUNBOOK', label: '런북 CLI' },
];
const TYPES = ['ALL', 'KILL_SWITCH', 'ADMISSION_TARGET', 'ADMISSION_PAUSE', 'BLOCK_ASN_IP', 'BOT_LEVEL', 'DEGRADED_MODE', 'LOG_LEVEL', 'FEATURE_OFF', 'AUTOMATION_STOP', 'PG_ASSIGN', 'TAKEDOWN', 'EVENT_CANCEL', 'SALE_STOP'] as const;
/** 재생 타이머 간격(화면 시계, 요청을 보내지 않는다) */
const REPLAY_TICK_MS = 250;

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const rawOf = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

function formatKst(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

function downloadJson(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ConnectedPage() {
  const layout = useLayout();
  const [sp] = useSearchParams();
  const eventId = sp.get('event');
  const [role, setRole] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('log');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [checkpoints, setCheckpoints] = useState<RawCheckpoint[]>([]);
  const [chain, setChain] = useState<ChainView>(() => chainViewOf([], {}, Date.now()));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey>('24h');
  const [actor, setActor] = useState<AuditActorFilter>('ALL');
  const [type, setType] = useState<string>('ALL');
  const [query, setQuery] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(() => Date.now());
  const [speed, setSpeed] = useState(1);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const canDetail = role === 'operator' || role === 'commander';
  const canExport = exportAvailability({ role: role ?? 'viewer', layout }).bundle;

  const selectedCheckpoint = useMemo(() => {
    if (!detail) return checkpoints[0] ?? null;
    const seq = Number(detail.seq);
    if (Number.isFinite(seq)) return checkpoints.find((c) => typeof c.fromSeq === 'number' && typeof c.toSeq === 'number' && seq >= c.fromSeq && seq <= c.toSeq) ?? checkpoints[0] ?? null;
    return checkpoints[0] ?? null;
  }, [detail, checkpoints]);

  const filtered = useMemo(() => {
    const span = PERIODS.find((p) => p.key === period)?.ms ?? null;
    return filterAuditRows(rows, { ...(span ? { fromMs: nowMs - span } : {}), actor, type, query });
  }, [rows, period, actor, type, query, nowMs]);

  const timeline = useMemo(() => replayTimelineOf(filtered, checkpoints), [filtered, checkpoints]);

  const loadAll = useCallback(async () => {
    if (!ensureConsoleApi()) {
      setLoad({ kind: 'config' });
      return;
    }
    setLoad((p) => (p.kind === 'ready' ? p : { kind: 'loading' }));
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      const [list, cps] = await Promise.all([
        ops.listOpsCommands({ limit: 100, ...(eventId ? { eventId } : {}) }),
        ops.listOpsAuditCheckpoints({ limit: 20 }),
      ]);
      const items = rawOf(list.data).items;
      setRows(auditRowsOf(Array.isArray(items) ? (items as RawAuditCommand[]) : []));
      const cpItems = rawOf(cps.data).items;
      const listCps = Array.isArray(cpItems) ? (cpItems as RawCheckpoint[]) : [];
      setCheckpoints(listCps);
      const verifications: Record<string, { valid?: unknown }> = {};
      await Promise.all(
        listCps.slice(0, 5).map(async (cp) => {
          const id = text(cp.checkpointId);
          if (!id) return;
          try {
            const v = await ops.getOpsAuditCheckpointVerification(id);
            verifications[id] = rawOf(v.data);
          } catch {
            // 검증을 읽지 못하면 배지를 '대기'로 둔다(0으로 그리지 않는다)
          }
        }),
      );
      setChain(chainViewOf(listCps, verifications, Date.now()));
      setLoad({ kind: 'ready' });
    } catch (e) {
      const p = rawOf(e);
      setLoad({ kind: 'error', message: p.status === 403 ? '감사 기록을 볼 권한이 없습니다' : '감사 기록을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요' });
    }
  }, [eventId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    let alive = true;
    if (!ensureConsoleApi()) return;
    void (async () => {
      try {
        const ops = await import('@peaket/api-client/endpoints/ops');
        const r = await ops.getMyOpsAuthSession();
        const got = text(rawOf(r.data).role);
        if (alive) setRole(got === 'commander' || got === 'operator' ? got : 'viewer');
      } catch {
        if (alive) setRole('viewer');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!canDetail || !selectedId) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetailError(null);
    void (async () => {
      try {
        const ops = await import('@peaket/api-client/endpoints/ops');
        const r = await ops.getOpsCommand(selectedId);
        if (alive) setDetail(rawOf(r.data));
      } catch {
        if (alive) setDetailError('명령 상세를 읽지 못했습니다');
      }
    })();
    return () => {
      alive = false;
    };
  }, [canDetail, selectedId]);

  useEffect(() => {
    setNowMs(Date.now());
    setPositionMs((p) => (p === 0 ? Date.now() : p));
  }, [rows]);

  useEffect(() => {
    clearInterval(tick.current);
    if (!playing || timeline.length === 0) return;
    tick.current = setInterval(() => {
      setPositionMs((prev) => {
        const next = prev + REPLAY_TICK_MS * speed;
        const end = timeline[timeline.length - 1].atMs;
        if (next >= end) {
          setPlaying(false);
          return end;
        }
        return next;
      });
    }, REPLAY_TICK_MS);
    return () => clearInterval(tick.current);
  }, [playing, speed, timeline]);

  const confirmExport = async (reason: string) => {
    const cp = selectedCheckpoint;
    const id = cp ? text(cp.checkpointId) : '';
    if (!id) {
      setExportError('내보낼 체크포인트를 고르세요');
      return;
    }
    setExportBusy(true);
    setExportError(null);
    try {
      const ops = await import('@peaket/api-client/endpoints/ops');
      const seq = Number(detail?.seq);
      const body = { reason, seq: Number.isFinite(seq) && seq > 0 ? seq : Number(cp?.fromSeq ?? 1) };
      const r = await ops.createOpsAuditVerificationBundle(id, body);
      downloadJson(`peaket-audit-bundle-${id}.json`, r.data);
      setExportOpen(false);
      setNotice('검증 묶음을 내보냈습니다. 내보낸 사실은 감사 기록에 남습니다.');
    } catch (e) {
      const p = rawOf(e);
      setExportError(p.status === 403 ? '검증 묶음은 commander만 내보낼 수 있습니다' : '검증 묶음을 내보내지 못했습니다. 잠시 뒤 다시 시도해 주세요');
    } finally {
      setExportBusy(false);
    }
  };

  if (load.kind === 'config') {
    return (
      <section className="widget" role="alert">
        <div className="widget-body t-sm">관제 API 주소가 설정되지 않아 감사 기록을 부를 수 없습니다.</div>
      </section>
    );
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1>감사 로그·인시던트 리플레이</h1>
          <p className="t-sm muted">명령 원장과 감사 체크포인트를 읽습니다. 원본 로그·명단 다운로드 기록은 원천 연결 전입니다.</p>
        </div>
        <button className="btn btn-outline" type="button" onClick={() => void loadAll()} disabled={load.kind === 'loading'}>
          <i className="ic ic-refresh" aria-hidden="true" /> 새로 고침
        </button>
      </div>

      <ChainBanner chain={chain} />

      {notice ? (
        <div className="banner banner-info" role="status">
          <div className="banner-body">{notice}</div>
        </div>
      ) : null}
      {load.kind === 'error' ? (
        <div className="banner banner-danger" role="alert">
          <div className="banner-body">{load.message}</div>
        </div>
      ) : null}

      <div className="row" role="tablist" aria-label="감사 화면 탭">
        <button type="button" role="tab" aria-selected={tab === 'log'} className={tab === 'log' ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'} onClick={() => setTab('log')}>
          감사 로그
        </button>
        <button type="button" role="tab" aria-selected={tab === 'downloads'} className={tab === 'downloads' ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'} onClick={() => setTab('downloads')}>
          명단 다운로드 기록
        </button>
      </div>

      {tab === 'downloads' ? (
        <section className="widget" aria-labelledby="audit-downloads-h">
          <div className="widget-head">
            <h2 className="t-sm fw-b" id="audit-downloads-h">명단 다운로드 기록</h2>
            <span className="badge">원천 연결 전</span>
          </div>
          <div className="widget-body t-sm muted">파트너 예매자 명단 보기·내려받기 기록을 읽는 경로가 아직 서버에 없습니다. 경로가 생기면 일시·계정·사유·건수를 여기서 봅니다.</div>
        </section>
      ) : (
        <div className="grid-12" style={{ rowGap: 16, alignItems: 'start' }}>
          <section className="widget span-8" aria-labelledby="audit-list-h">
            <div className="widget-head">
              <h2 className="t-sm fw-b" id="audit-list-h">감사 기록</h2>
              <span className="badge">{filtered.length}건</span>
            </div>
            <div className="widget-body col" style={{ padding: 12, gap: 10 }}>
              <div className="row wrap" style={{ gap: 8 }} role="group" aria-label="감사 기록 거르기">
                <label className="field" style={{ minWidth: 140 }}>
                  <span className="label">기간</span>
                  <select className="input" value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)}>
                    {PERIODS.map((p) => (
                      <option key={p.key} value={p.key}>{p.label}</option>
                    ))}
                  </select>
                </label>
                <label className="field" style={{ minWidth: 140 }}>
                  <span className="label">행위자</span>
                  <select className="input" value={actor} onChange={(e) => setActor(e.target.value as AuditActorFilter)}>
                    {ACTORS.map((a) => (
                      <option key={a.key} value={a.key}>{a.label}</option>
                    ))}
                  </select>
                </label>
                <label className="field" style={{ minWidth: 160 }}>
                  <span className="label">종류</span>
                  <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                    {TYPES.map((t) => (
                      <option key={t} value={t}>{t === 'ALL' ? '모든 종류' : t}</option>
                    ))}
                  </select>
                </label>
                <label className="field" style={{ flex: 1, minWidth: 180 }}>
                  <span className="label">검색(명령 ID·사유·회차)</span>
                  <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} />
                </label>
              </div>
              {load.kind === 'loading' ? <p className="t-sm muted" role="status">감사 기록을 불러오는 중…</p> : null}
              <AuditTable rows={filtered} selectedId={selectedId} onSelect={setSelectedId} />
            </div>
          </section>

          <div className="span-4 col" style={{ gap: 16 }}>
            <section className="widget" aria-labelledby="audit-detail-h">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="audit-detail-h">기록 상세</h2>
                {canExport ? (
                  <button className="btn btn-outline btn-sm" type="button" onClick={() => { setExportError(null); setExportOpen(true); }} aria-disabled={selectedCheckpoint === null}>
                    검증 묶음
                  </button>
                ) : null}
              </div>
              <div className="widget-body col" style={{ padding: 12, gap: 8 }}>
                {!selectedId ? <p className="t-sm muted">왼쪽에서 기록을 고르세요.</p> : null}
                {selectedId && !canDetail ? <p className="t-sm muted">상세는 operator·commander만 볼 수 있습니다. 목록 요약만 보입니다.</p> : null}
                {detailError ? <p className="error-msg" role="alert">{detailError}</p> : null}
                {detail ? (
                  <>
                    <p className="t-sm">{text(detail.reason) || '사유 없음'}</p>
                    <dl className="kv t-sm">
                      <dt>명령</dt><dd>{text(detail.commandId) || selectedId}</dd>
                      <dt>유형</dt><dd>{text(detail.type)}</dd>
                      <dt>상태</dt><dd>{text(detail.state)}</dd>
                      <dt>접수</dt><dd>{formatKst(text(detail.createdAt))}</dd>
                      <dt>ack</dt><dd>{formatKst(text(detail.ackedAt))}</dd>
                      <dt>승인자</dt><dd>{Array.isArray(detail.approvals) && detail.approvals.length > 0 ? detail.approvals.join(', ') : '—'}</dd>
                    </dl>
                    <details>
                      <summary className="t-sm">매개변수·dry-run·전달</summary>
                      <pre className="t-xs" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify({ params: detail.params ?? null, dryRun: detail.dryRun ?? null, delivery: detail.delivery ?? null }, null, 2)}</pre>
                    </details>
                  </>
                ) : null}
                {selectedCheckpoint ? (
                  <p className="t-xs muted">검증 묶음은 체크포인트 {text(selectedCheckpoint.checkpointId)} 구간에서 냅니다.</p>
                ) : null}
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setExportOpen(true)} disabled={!canExport || selectedCheckpoint === null} aria-disabled={!canExport || selectedCheckpoint === null} title={canExport ? undefined : exportAvailability({ role: role ?? 'viewer', layout }).reason}>
                  검증 묶음 내보내기
                </button>
              </div>
            </section>

            {layout !== 'phone' ? (
              <ReplayPlayer
                timeline={timeline}
                layout={layout}
                positionMs={positionMs || timeline[0]?.atMs || nowMs}
                playing={playing}
                speed={speed}
                onToggle={() => setPlaying((p) => !p)}
                onSeek={(ms) => {
                  setPlaying(false);
                  setPositionMs(ms);
                }}
                onSpeed={setSpeed}
              />
            ) : null}
          </div>
        </div>
      )}

      <ExportBundleDialog
        open={exportOpen}
        role={role ?? 'viewer'}
        layout={layout}
        checkpoint={
          selectedCheckpoint
            ? {
                checkpointId: text(selectedCheckpoint.checkpointId),
                fromSeq: typeof selectedCheckpoint.fromSeq === 'number' ? selectedCheckpoint.fromSeq : 0,
                toSeq: typeof selectedCheckpoint.toSeq === 'number' ? selectedCheckpoint.toSeq : 0,
                reason: text(selectedCheckpoint.reason),
              }
            : null
        }
        busy={exportBusy}
        error={exportError}
        onConfirm={(reason) => void confirmExport(reason)}
        onClose={() => setExportOpen(false)}
      />
    </div>
  );
}
