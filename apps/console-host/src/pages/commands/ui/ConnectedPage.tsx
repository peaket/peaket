// SCR-030 연결 화면: 명령 1·3·6(결제 갈래)을 dry-run·재인증·2인 승인을 거쳐 내고, 받는 쪽 ack와 되돌리기를 명령 카드로 본다(F-03-4, OPS-390).
// 목록·상세·승인·반려·다시 시도와 감사 체크포인트 탭은 BAT-465(GAT-300·GAT-310)에서 왔다.
// - 역할은 서버(GET /v1/ops/auth/sessions/me)에서 읽는다. 미리보기 ?role=은 보드(?state=)에서만 쓴다. viewer는 목록만 보고 상세를 부르지 않는다.
// - 갱신: 호스트가 연 늘 여는 흐름의 command 사건은 다시 읽기 방아쇠이고, 값은 REST로 다시 읽는다(model/command-sync.ts, ADR-0100).
//   DISPATCHED인 동안은 3초마다 상세를 다시 읽는다(감독 결정 2026-11-23).
// - 요청 흐름(재인증 OPS_COMMAND·멱등 키·막힘)은 model/command-actions.ts. 재인증 토큰은 대화상자에서 그 요청으로 바로 넘기고 화면 상태에 두지 않는다.
// - 위 상태 바(자동 제어·단계)는 덮지 않는다(호스트가 받은 실제 값 그대로, 계획 1-11).
// 디자인 보드(ui/Page.tsx의 BoardPage)는 ?state= 미리보기에 남기고, 실제 경로는 이 화면을 쓴다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ReauthDialog } from '@/features/admin-reauth/ReauthDialog';
import { ensureConsoleApi, opsApiAvailable } from '@/shared/api';
import { onLive, setLiveEvent } from '@/shared/api/live';
import { useLayout } from '@/shared/lib/layout';
import { useLiveHost } from '@/shared/model/live-host';
import { filterCommands, formatKstDateTime, stateLabel, stateTone, typeLabel, type CommandRow, type CommandStateValue } from '../model/commands';
import { commandAvailability, commandBodyOf, Submission, type CommandDraft, type CommandKind, type ConsoleRole, type SimpleCommandDraft } from '../model/command-form';
import { createCommandActions, type ActionResult, type CommandDetail } from '../model/command-actions';
import { syncCommands, type CommandSync } from '../model/command-sync';
import { commandCardState } from '../model/card-state';
import type { DryRunView } from '../model/dry-run';
import { CommandCatalog } from './connected/CommandCatalog';
import { CommandForm } from './connected/CommandForm';
import { MoreCommands } from './connected/MoreCommands';
import { AutoActionStrip, AutoResumeDialog, EffectStrip } from './connected/CommandExtras';
import { effectRowOf, type EffectRow } from '../model/command-effects';
import { autoActionView } from '../model/auto-actions';
import { autoResumePrompt, autoResumeView } from '../model/auto-resume';
import { DryRunPanel } from './connected/DryRunPanel';
import { CommandCard } from './connected/CommandCard';
import { KillSwitchConfirm } from './connected/KillSwitchConfirm';
import { RevertDialog } from './connected/RevertDialog';

type Load = { kind: 'loading' } | { kind: 'ready'; items: CommandRow[]; nextCursor: string | null } | { kind: 'error'; message: string } | { kind: 'config' };
type CheckpointRow = { checkpointId: string; fromSeq: number; toSeq: number; rootHash: string; prevCheckpointHash: string; reason: string; actorRef: string; createdAt: string };
type Verification = { valid: boolean; rootValid: boolean; prevValid: boolean };

/** 끝 상태: 이 상태가 되면 감사 탭이 체크포인트를 다시 읽는다(옛 audit 사건 대신, ADR-0360 결정 8) */
const TERMINAL = new Set<string>(['SUCCEEDED', 'FAILED', 'REVERTED', 'ACKED']);
const STATES: readonly CommandStateValue[] = ['PENDING_APPROVAL', 'DISPATCHED', 'SUCCEEDED', 'FAILED', 'APPROVED', 'REJECTED', 'REVERT_PENDING', 'REVERTED', 'AUTO_EXPIRED', 'DRAFTED', 'DRY_RUN', 'ACKED'];
const TYPES = ['EVENT_CANCEL', 'SCALE_CHANGE', 'SALE_STOP', 'SALE_RESUME', 'KILL_SWITCH', 'ADMISSION_PAUSE', 'ADMISSION_TARGET', 'BOT_LEVEL', 'DEGRADED_MODE', 'BLOCK_ASN_IP', 'LOBBY_BANNER', 'LOG_LEVEL', 'FEATURE_OFF', 'TAKEDOWN', 'AUTOMATION_STOP', 'PG_ASSIGN'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 작성 칸이 차고 이만큼 멈추면 dry-run을 부른다 [가정](계획 6-7) */
const DRY_RUN_DEBOUNCE_MS = 500;
/** 재인증 대화상자 글(d5 §7.3 명령 3 ④ 재인증 칸) */
const REAUTH_LINE = '실행 직전에 비밀번호와 인증 앱 코드로 다시 인증하고, 등록한 패스키로 한 번 더 확인합니다(5분 재인증 토큰).';
/** 해제 갈래의 결제사 흉내 서버(SIMULATOR)는 local·ci만 받는다(openapi Command.params 설명). 루프백 관제 API에 붙은 빌드에서만 고르게 한다(서버가 다시 막는다) */
const SIMULATOR_ALLOWED = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/.test(__OPS_API_ORIGIN__);
/** 남은 시간·전파 지연을 다시 그리는 화면 시계(요청을 보내지 않는다) */
const CLOCK_MS = 1_000;

function draftOf(kind: CommandKind, eventId: string | null): SimpleCommandDraft {
  const ev = eventId ?? '';
  if (kind === 'ADMISSION_TARGET') return { kind, eventId: ev, target: Number.NaN, reason: '' };
  if (kind === 'KILL_SWITCH') return { kind, scope: 'EVENT', ...(eventId ? { eventId } : {}), reason: '' };
  if (kind === 'PG_ENTRY_RELEASE') return { kind, reason: '' };
  return { kind: 'PG_FALLBACK', scope: 'EVENT', ...(eventId ? { eventId } : {}), reason: '' };
}

function withEvent(d: SimpleCommandDraft, eventId: string | null): SimpleCommandDraft {
  if (d.kind === 'ADMISSION_TARGET') return { ...d, eventId: eventId ?? '' };
  // 해제 갈래는 회차 범위가 없다(결제사 하나)
  if (d.kind === 'PG_ENTRY_RELEASE') return d;
  const ev = eventId ? { eventId } : {};
  if (d.kind === 'KILL_SWITCH') return { kind: 'KILL_SWITCH', scope: d.scope, reason: d.reason, ...ev };
  return { kind: 'PG_FALLBACK', scope: d.scope, reason: d.reason, ...ev, ...(d.toPg ? { toPg: d.toPg } : {}) };
}

function doneMessage(c: CommandDetail): string {
  switch (c.state) {
    case 'PENDING_APPROVAL':
      return '승인을 요청했습니다. 요청자가 아닌 운영자가 10분 안에 승인해야 실행됩니다.';
    case 'REVERT_PENDING':
      return '재개 승인을 요청했습니다. 요청자가 아닌 운영자가 승인하면 되돌립니다.';
    case 'REVERTED':
      return '되돌렸습니다.';
    case 'REJECTED':
      return '반려했습니다.';
    default:
      return '보냈습니다. 받는 서버들이 적용을 알릴 때까지 카드에서 확인해 주세요.';
  }
}

export function ConnectedPage() {
  const layout = useLayout();
  const [params] = useSearchParams();
  const eventParam = params.get('event');
  const eventId = eventParam && UUID.test(eventParam) ? eventParam.toLowerCase() : null;
  const [role, setRole] = useState<ConsoleRole | null>(null);
  const canCheckpoint = role === 'commander';
  const canDetail = role === 'operator' || role === 'commander';
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CommandDetail | null>(null);
  const [stateFilter, setStateFilter] = useState<CommandStateValue | 'ALL'>('ALL');
  const [typeFilter, setTypeFilter] = useState<string | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'commands' | 'audit'>('commands');
  const [checkpoints, setCheckpoints] = useState<readonly CheckpointRow[]>([]);
  const [verifications, setVerifications] = useState<Record<string, Verification>>({});
  const [checkpointReason, setCheckpointReason] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [live, setLive] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [draft, setDraft] = useState<SimpleCommandDraft | null>(null);
  const [dryRun, setDryRun] = useState<{ view: DryRunView | null; error?: string }>({ view: null });
  const [formError, setFormError] = useState<string | null>(null);
  const [killOpen, setKillOpen] = useState(false);
  const [revertOpen, setRevertOpen] = useState(false);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const syncRef = useRef<CommandSync | null>(null);
  const reauthResolve = useRef<((token: string | null) => void) | null>(null);
  /** 명령마다 화면이 DISPATCHED를 처음 본 시각(전파 지연 3초를 센다) */
  const dispatchSeen = useRef(new Map<string, number>());
  /** 같은 작성 값이면 같은 제출(같은 멱등 키), 값이 바뀌면 새 제출 */
  const submission = useRef<{ key: string; sub: Submission } | null>(null);

  const notify = useCallback((text: string) => {
    clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  // 역할은 서버 세션에서(계획 1-1). 읽지 못하면 가장 좁은 viewer로 본다(권한은 서버가 막는다)
  useEffect(() => {
    if (!ensureConsoleApi()) {
      setLoad({ kind: 'config' });
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const { getMyOpsAuthSession } = await import('@peaket/api-client/endpoints/ops');
        const r = await getMyOpsAuthSession();
        const got = (r.data as { role?: string }).role;
        if (alive) setRole(got === 'commander' || got === 'operator' ? got : 'viewer');
      } catch {
        if (alive) setRole('viewer');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 고른 회차(?event=)를 늘 여는 흐름에 알린다(대시보드와 같은 길)
  useEffect(() => {
    if (opsApiAvailable()) setLiveEvent(eventId, 'commands');
    setDraft((d) => (d ? withEvent(d, eventId) : d));
  }, [eventId]);

  const onDetail = useCallback((d: CommandDetail) => {
    if (d.commandId) {
      if (d.state === 'DISPATCHED' || d.state === 'APPROVED') {
        if (!dispatchSeen.current.has(d.commandId)) dispatchSeen.current.set(d.commandId, Date.now());
      } else dispatchSeen.current.delete(d.commandId);
    }
    setDetail(d);
  }, []);

  // 목록·상세 다시 읽기(흐름 사건·reset·DISPATCHED 3초)
  useEffect(() => {
    if (!role || !ensureConsoleApi()) return;
    const sync = syncCommands({
      role,
      onList: (page) => {
        setLoad({ kind: 'ready', ...page });
        setSelectedId((prev) => prev ?? page.items[0]?.commandId ?? null);
      },
      onDetail,
      onListError: () => setLoad({ kind: 'error', message: '명령 목록을 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' }),
      onDetailError: () => notify('명령 상세를 불러오지 못했습니다.'),
    });
    syncRef.current = sync;
    if (selectedRef.current) sync.select(selectedRef.current);
    return () => {
      sync.stop();
      syncRef.current = null;
    };
  }, [role, onDetail, notify]);

  useEffect(() => {
    setDetail(null);
    setRejectOpen(false);
    syncRef.current?.select(selectedId);
  }, [selectedId]);

  const loadCheckpoints = useCallback(async () => {
    if (!ensureConsoleApi()) return;
    try {
      const [{ listOpsAuditCheckpoints }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await listOpsAuditCheckpoints({ limit: 50 });
      setCheckpoints((r.data.items ?? []) as CheckpointRow[]);
    } catch {
      notify('감사 체크포인트를 불러오지 못했습니다.');
    }
  }, [notify]);

  // 감사 탭: 명령이 끝 상태가 되거나 reset이면 체크포인트를 다시 읽는다
  useEffect(() => {
    if (!opsApiAvailable()) {
      setLive('closed');
      return () => clearTimeout(toastTimer.current);
    }
    const offCommand = onLive('command', (data) => {
      const state = (data as { state?: unknown } | null)?.state;
      if (tabRef.current === 'audit' && typeof state === 'string' && TERMINAL.has(state)) void loadCheckpoints();
    });
    const offReset = onLive('reset', () => {
      if (tabRef.current === 'audit') void loadCheckpoints();
    });
    return () => {
      offCommand();
      offReset();
      clearTimeout(toastTimer.current);
    };
  }, [loadCheckpoints]);

  // 흐름 상태는 호스트 연결에서 읽는다
  const connected = useLiveHost((s) => s.connected);
  const liveAutoActions = useLiveHost((s) => s.autoActions);
  const controlKind = useLiveHost((s) => s.control.kind);
  const [autoResumeOpen, setAutoResumeOpen] = useState(false);
  const prevControlKind = useRef(controlKind);
  useEffect(() => {
    const prev = prevControlKind.current;
    prevControlKind.current = controlKind;
    if (autoResumePrompt(prev, controlKind) === 'open') setAutoResumeOpen(true);
  }, [controlKind]);
  useEffect(() => {
    if (opsApiAvailable()) setLive(connected ? 'open' : 'connecting');
  }, [connected]);

  useEffect(() => {
    if (tab === 'audit') void loadCheckpoints();
  }, [tab, loadCheckpoints]);

  // 카드의 남은 시간·전파 지연을 다시 그리는 시계(대기·전파 중인 명령이 열려 있을 때만)
  const ticking = detail?.state === 'PENDING_APPROVAL' || detail?.state === 'REVERT_PENDING' || detail?.state === 'DISPATCHED' || detail?.state === 'APPROVED';
  useEffect(() => {
    if (!ticking) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
    return () => clearInterval(t);
  }, [ticking]);

  /** 재인증 대화상자를 띄워 토큰을 돌려준다(닫으면 null). 토큰은 화면 상태에 두지 않는다 */
  const promptReauth = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        reauthResolve.current?.(null);
        reauthResolve.current = resolve;
        setReauthOpen(true);
      }),
    [],
  );
  const finishReauth = (token: string | null) => {
    const r = reauthResolve.current;
    reauthResolve.current = null;
    setReauthOpen(false);
    r?.(token);
  };

  const actions = useMemo(() => (role ? createCommandActions({ role, layout, reauth: promptReauth }) : null), [role, layout, promptReauth]);

  // dry-run: 작성 칸이 모두 차고 0.5초 멈추면 한 번, 그 뒤 값이 바뀔 때마다(계획 6-7)
  const draftKey = draft ? JSON.stringify(draft) : '';
  useEffect(() => {
    setFormError(null);
    if (!draft || !actions || !commandBodyOf(draft)) {
      setDryRun({ view: null });
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      void actions.dryRun(draft).then((r) => {
        if (!alive) return;
        if (r.kind === 'ok') setDryRun({ view: r.view });
        else if (r.kind === 'problem') setDryRun({ view: null, error: r.message });
        else if (r.kind === 'blocked') setDryRun({ view: null, error: r.reason });
        else setDryRun({ view: null });
      });
    }, DRY_RUN_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // draftKey가 draft의 값을 대신한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, actions]);

  const items = load.kind === 'ready' ? load.items : [];
  const filtered = useMemo(() => filterCommands(items, { state: stateFilter, type: typeFilter, query }), [items, stateFilter, typeFilter, query]);

  /** 결과를 화면에 알리고 목록·상세를 다시 읽는다 */
  const settle = (r: ActionResult, ok?: (c: CommandDetail) => void): boolean => {
    switch (r.kind) {
      case 'done':
        notify(doneMessage(r.command));
        if (r.command?.commandId) onDetail(r.command);
        ok?.(r.command);
        syncRef.current?.refresh();
        return true;
      case 'problem':
        notify(r.message);
        return false;
      case 'cancelled':
        notify('다시 인증하지 않아 보내지 않았습니다.');
        return false;
      case 'blocked':
        notify(r.reason);
        return false;
      case 'invalid':
        notify('사유와 칸을 모두 채워 주세요.');
        return false;
      case 'busy':
        return false;
    }
  };

  const run = async (fn: () => Promise<ActionResult>, ok?: (c: CommandDetail) => void): Promise<ActionResult | null> => {
    if (busy) return null;
    setBusy(true);
    try {
      const r = await fn();
      settle(r, ok);
      return r;
    } finally {
      setBusy(false);
    }
  };

  const submissionFor = (d: CommandDraft): Submission => {
    const key = JSON.stringify(d);
    if (submission.current?.key !== key) submission.current = { key, sub: new Submission() };
    return submission.current.sub;
  };

  const send = async (d: CommandDraft) => {
    if (!actions) return;
    const reauth = dryRun.view ? dryRun.view.reauth : d.kind !== 'ADMISSION_TARGET';
    const r = await run(
      () => actions.submit(d, submissionFor(d), { reauth }),
      (c) => {
        submission.current = null;
        setDraft(null);
        setKillOpen(false);
        if (c.commandId) setSelectedId(c.commandId);
      },
    );
    if (r?.kind === 'problem') setFormError(r.message);
  };

  const approve = () => detail && actions && void run(() => actions.approve(detail));
  const retry = () => detail && actions && void run(() => actions.retry(detail));
  const reject = () =>
    detail &&
    actions &&
    void run(
      () => actions.reject(detail, rejectReason),
      () => {
        setRejectOpen(false);
        setRejectReason('');
      },
    );
  const revert = (reason: string) => detail && actions && void run(() => actions.revert(detail, reason), () => setRevertOpen(false));

  const createCheckpoint = async () => {
    if (busy || checkpointReason.trim() === '' || !ensureConsoleApi()) return;
    setBusy(true);
    try {
      const [{ createOpsAuditCheckpoint }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      await createOpsAuditCheckpoint({ reason: checkpointReason.trim() });
      setCheckpointReason('');
      await loadCheckpoints();
      notify('감사 체크포인트를 만들었습니다.');
    } catch {
      notify('처리하지 못했습니다. 권한과 명령 상태를 확인해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (checkpointId: string) => {
    try {
      const [{ getOpsAuditCheckpointVerification }] = await Promise.all([import('@peaket/api-client/endpoints/ops')]);
      const r = await getOpsAuditCheckpointVerification(checkpointId);
      setVerifications((prev) => ({ ...prev, [checkpointId]: r.data as Verification }));
    } catch {
      notify('검증하지 못했습니다.');
    }
  };

  if (load.kind === 'config' || !opsApiAvailable()) {
    return (
      <section className="widget" role="alert">
        <h1 className="t-xl">운영 명령</h1>
        <p className="t-sm muted">관제 API 주소가 설정되지 않아 명령 목록을 부를 수 없습니다. 빌드의 `PEAKET_OPS_API_ORIGIN`을 확인해 주세요.</p>
      </section>
    );
  }

  const viewRole: ConsoleRole = role ?? 'viewer';
  const availability = draft ? commandAvailability({ role: viewRole, layout, kind: draft.kind }) : { canRequest: false };
  const card = detail ? commandCardState(detail, { nowMs, ...(detail.commandId && dispatchSeen.current.has(detail.commandId) ? { dispatchSeenAtMs: dispatchSeen.current.get(detail.commandId)! } : {}) }) : null;
  const selectedRow = items.find((c) => c.commandId === selectedId) ?? null;
  const autoView = autoActionView(liveAutoActions, nowMs);
  const autoResume = autoResumeView(autoResumeOpen ? 'open' : 'none');
  const effectRows: { type: string; row: EffectRow }[] = [];
  if (detail && (detail.type === 'BLOCK_ASN_IP' || detail.type === 'BOT_LEVEL')) {
    const row = effectRowOf({ type: detail.type, ackedAt: (detail as { ackedAt?: string | null }).ackedAt ?? null, nowMs });
    if (row) effectRows.push({ type: detail.type, row });
  }

  const sendMore = async (d: CommandDraft) => {
    if (!actions) return;
    const dry = await actions.dryRun(d);
    const reauth = dry.kind === 'ok' ? dry.view.reauth : true;
    const r = await run(
      () => actions.submit(d, new Submission(), { reauth }),
      (c) => {
        if (c.commandId) setSelectedId(c.commandId);
      },
    );
    if (r?.kind === 'problem') setFormError(r.message);
  };

  return (
    <>
      {/* 휴대폰(320px)에서는 제목과 오른쪽 단추를 세로로 쌓아 제목이 한 글자씩 줄바꿈되지 않게 한다(계획 §9·§10) */}
      <div className={layout === 'phone' ? 'col' : 'row between'} style={{ alignItems: layout === 'phone' ? 'flex-start' : 'flex-end', gap: layout === 'phone' ? 8 : 24 }}>
        <div className="col" style={{ gap: 4 }}>
          <h1 className="t-xl">운영 명령</h1>
          <p className="t-sm muted">명령을 내고, 받는 서버들의 적용 확인과 감사 체크포인트를 봅니다. 2인 명령은 요청자와 다른 운영자만 승인할 수 있습니다.</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className={`badge badge-${live === 'open' ? 'success' : live === 'connecting' ? 'warning' : 'outline'}`} title="관제 SSE(/v1/ops/live) 연결 상태">
            {live === 'open' ? '실시간' : live === 'connecting' ? '연결 중' : '다시 연결 중'}
          </span>
          <button className="btn btn-outline" type="button" onClick={() => syncRef.current?.refresh()} disabled={busy}>
            <i className="ic ic-refresh" aria-hidden="true" /> 새로 고침
          </button>
        </div>
      </div>

      <div className="col" style={{ gap: 8, marginTop: 12 }}>
        <AutoActionStrip stuck={autoView.stuck} recentlyCleared={autoView.recentlyCleared} unavailable={autoView.unavailable} message={autoView.message} />
        <EffectStrip rows={effectRows} />
      </div>

      <div className="tabs" style={{ marginTop: 16 }} role="tablist" aria-label="운영 명령 탭">
        <button className={tab === 'commands' ? 'tab active' : 'tab'} type="button" role="tab" aria-selected={tab === 'commands'} onClick={() => setTab('commands')}>
          명령
        </button>
        <button className={tab === 'audit' ? 'tab active' : 'tab'} type="button" role="tab" aria-selected={tab === 'audit'} onClick={() => setTab('audit')}>
          감사 체크포인트
        </button>
      </div>

      {tab === 'commands' ? (
        <div className="grid-12" style={{ rowGap: 16, alignItems: 'start', marginTop: 16 }}>
          <div className={`${layout === 'phone' ? 'span-12' : 'span-4'} col`} style={{ gap: 16 }}>
            {role ? <CommandCatalog role={viewRole} layout={layout} picked={draft?.kind ?? null} onPick={(kind) => { if (kind === 'ADMISSION_TARGET' || kind === 'KILL_SWITCH' || kind === 'PG_FALLBACK' || kind === 'PG_ENTRY_RELEASE') setDraft(draftOf(kind, eventId)); }} /> : null}
            {role ? <MoreCommands role={viewRole} layout={layout} eventId={eventId} busy={busy} onSend={(d) => void sendMore(d)} /> : null}
            {draft && layout !== 'phone' ? (
              <section className="widget" aria-labelledby="h-form">
                <div className="widget-head">
                  <h2 className="t-sm fw-b" id="h-form">
                    {draft.kind === 'ADMISSION_TARGET' ? '동시 입장 목표 조정' : draft.kind === 'KILL_SWITCH' ? '판매 일시정지' : draft.kind === 'PG_ENTRY_RELEASE' ? '새 결제 진입 정지 열기' : '대체 결제사 전환'}
                  </h2>
                  <button className="btn btn-ghost" type="button" onClick={() => setDraft(null)}>
                    닫기
                  </button>
                </div>
                {!eventId ? <p className="t-xs muted">위에서 회차를 고르면 이 회차 범위로 낼 수 있습니다.</p> : null}
                <CommandForm
                  draft={draft}
                  onChange={setDraft}
                  availability={availability}
                  busy={busy}
                  ready={commandBodyOf(draft) !== null}
                  allowSimulator={SIMULATOR_ALLOWED}
                  onSubmit={() => (draft.kind === 'KILL_SWITCH' ? setKillOpen(true) : void send(draft))}
                />
                {formError ? (
                  <p className="t-sm" role="alert" style={{ color: 'var(--danger)', marginTop: 8 }}>
                    {formError}
                  </p>
                ) : null}
                <div style={{ marginTop: 12 }}>
                  <DryRunPanel view={dryRun.view} {...(dryRun.error ? { error: dryRun.error } : {})} />
                </div>
              </section>
            ) : null}
          </div>

          <div className={`${layout === 'phone' ? 'span-12' : 'span-4'} col`} style={{ gap: 16 }}>
            <section className="widget" aria-labelledby="h-cmd">
              <div className="widget-head" style={{ flexWrap: 'wrap' }}>
                <h2 className="t-sm fw-b" id="h-cmd">명령 {filtered.length}건</h2>
                <div className="actions" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <select aria-label="상태" value={stateFilter} onChange={(e) => setStateFilter(e.currentTarget.value as CommandStateValue | 'ALL')}>
                    <option value="ALL">전체 상태</option>
                    {STATES.map((s) => <option key={s} value={s}>{stateLabel(s)}</option>)}
                  </select>
                  <select aria-label="유형" value={typeFilter} onChange={(e) => setTypeFilter(e.currentTarget.value)}>
                    <option value="ALL">전체 유형</option>
                    {TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
                  </select>
                </div>
              </div>
              <div className="input-group input-group-sm" style={{ marginTop: 8 }}>
                <input aria-label="검색" placeholder="사유·명령 ID·유형" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
              </div>
              {load.kind === 'loading' ? <p className="t-sm muted" style={{ marginTop: 12 }}>불러오는 중…</p> : null}
              {load.kind === 'error' ? <p className="t-sm" role="alert" style={{ marginTop: 12 }}>{load.message}</p> : null}
              <ul className="col" style={{ gap: 8, marginTop: 12, listStyle: 'none', padding: 0 }}>
                {filtered.map((c) => (
                  <li key={c.commandId}>
                    <button
                      type="button"
                      className={selectedId === c.commandId ? 'btn btn-outline' : 'btn btn-ghost'}
                      // .btn의 nowrap을 풀고 긴 사유·UUID가 줄바꿈되게 한다(320px 가로 스크롤 방지)
                      style={{ width: '100%', textAlign: 'left', display: 'block', padding: 12, whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                      onClick={() => setSelectedId(c.commandId)}
                    >
                      <span className="row between" style={{ gap: 8 }}>
                        <span className="t-sm fw-b">{typeLabel(c.type)}</span>
                        <span className={`badge badge-${stateTone(c.state)}`}>{stateLabel(c.state)}</span>
                      </span>
                      <span className="t-xs muted" style={{ display: 'block', marginTop: 4 }}>{c.reason}</span>
                      <span className="t-xs muted" style={{ display: 'block', marginTop: 4 }}>
                        {formatKstDateTime(c.createdAt)} · 시도 {c.attempts}회
                      </span>
                    </button>
                  </li>
                ))}
                {load.kind === 'ready' && filtered.length === 0 ? <li className="t-sm muted">조건에 맞는 명령이 없습니다.</li> : null}
              </ul>
            </section>
          </div>

          <div className={`${layout === 'phone' ? 'span-12' : 'span-4'} col`} style={{ gap: 16 }}>
            <section className="widget" aria-labelledby="h-detail">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-detail">명령 상세</h2>
                {live !== 'open' && detail ? <span className="badge badge-warning">연결 중</span> : null}
              </div>
              {!canDetail ? (
                selectedRow ? (
                  <p className="t-sm" style={{ marginTop: 12 }}>
                    {typeLabel(selectedRow.type)} · {stateLabel(selectedRow.state)} — viewer는 목록만 봅니다.
                  </p>
                ) : (
                  <p className="t-sm muted" style={{ marginTop: 12 }}>viewer는 목록만 봅니다.</p>
                )
              ) : !detail || !card ? (
                <p className="t-sm muted" style={{ marginTop: 12 }}>{selectedId ? '불러오는 중…' : '가운데 목록에서 명령을 고르세요.'}</p>
              ) : (
                <div className="col" style={{ gap: 12, marginTop: 12 }}>
                  <CommandCard
                    detail={detail}
                    state={card}
                    role={viewRole}
                    layout={layout}
                    busy={busy}
                    onApprove={() => void approve()}
                    onReject={() => setRejectOpen(true)}
                    onRetry={() => void retry()}
                    onRevert={() => setRevertOpen(true)}
                  />
                  {rejectOpen ? (
                    <div className="widget" style={{ padding: 12 }}>
                      <label className="t-sm" htmlFor="reject-reason">반려 사유</label>
                      <textarea id="reject-reason" className="input" rows={3} maxLength={2000} value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} />
                      <div className="row" style={{ gap: 8, marginTop: 8 }}>
                        <button className="btn btn-primary" type="button" disabled={busy || rejectReason.trim() === ''} onClick={() => void reject()}>반려 확정</button>
                        <button className="btn btn-ghost" type="button" onClick={() => setRejectOpen(false)}>취소</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </section>
          </div>
        </div>
      ) : (
        <div className="grid-12" style={{ rowGap: 16, alignItems: 'start', marginTop: 16 }}>
          <div className={`${layout === 'phone' ? 'span-12' : 'span-7'} col`} style={{ gap: 16 }}>
            <section className="widget" aria-labelledby="h-cp">
              <div className="widget-head">
                <h2 className="t-sm fw-b" id="h-cp">감사 체크포인트 {checkpoints.length}건</h2>
                <button className="btn btn-outline" type="button" onClick={() => void loadCheckpoints()}>새로 고침</button>
              </div>
              <table className="table" style={{ marginTop: 12 }}>
                <thead>
                  <tr><th>만든 시각</th><th>구간</th><th>사유</th><th>검증</th></tr>
                </thead>
                <tbody>
                  {checkpoints.map((cp) => {
                    const v = verifications[cp.checkpointId];
                    return (
                      <tr key={cp.checkpointId}>
                        <td className="t-xs">{formatKstDateTime(cp.createdAt)}</td>
                        <td className="t-xs">{cp.fromSeq}–{cp.toSeq}</td>
                        <td className="t-xs">{cp.reason}</td>
                        <td>
                          <button className="btn btn-ghost" type="button" onClick={() => void verify(cp.checkpointId)}>검증</button>
                          {v ? <span className={`badge badge-${v.valid ? 'success' : 'danger'}`} style={{ marginLeft: 6 }}>{v.valid ? '통과' : '실패'}</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                  {checkpoints.length === 0 ? <tr><td colSpan={4} className="t-sm muted">체크포인트가 없습니다.</td></tr> : null}
                </tbody>
              </table>
            </section>
          </div>
          <div className={`${layout === 'phone' ? 'span-12' : 'span-5'} col`} style={{ gap: 16 }}>
            <section className="widget" aria-labelledby="h-cp-new">
              <div className="widget-head"><h2 className="t-sm fw-b" id="h-cp-new">체크포인트 만들기</h2></div>
              <p className="t-xs muted" style={{ marginTop: 8 }}>마지막 체크포인트 뒤부터 지금 감사 체인 머리까지를 SHA-256 루트로 묶습니다. commander만 만들 수 있습니다.</p>
              <label className="t-sm" htmlFor="cp-reason">사유</label>
              <input id="cp-reason" className="input" value={checkpointReason} onChange={(e) => setCheckpointReason(e.currentTarget.value)} disabled={!canCheckpoint} />
              <button className="btn btn-primary" type="button" style={{ marginTop: 8 }} disabled={busy || !canCheckpoint || checkpointReason.trim() === ''} onClick={() => void createCheckpoint()}>
                체크포인트 만들기
              </button>
            </section>
          </div>
        </div>
      )}

      {killOpen && draft?.kind === 'KILL_SWITCH' ? (
        <KillSwitchConfirm
          scope={draft.scope}
          {...(draft.eventId ? { eventId: draft.eventId } : {})}
          initialReason={draft.reason}
          busy={busy}
          onClose={() => setKillOpen(false)}
          onConfirm={(reason) => void send({ ...draft, reason })}
        />
      ) : null}
      {revertOpen && detail ? <RevertDialog detail={detail} busy={busy} onClose={() => setRevertOpen(false)} onConfirm={(reason) => revert(reason)} /> : null}
      <AutoResumeDialog open={autoResumeOpen} why={autoResume.why ?? null} onClose={() => setAutoResumeOpen(false)} />
      <ReauthDialog open={reauthOpen} act="OPS_COMMAND" title="명령을 보내기 전에 다시 인증해 주세요" description={REAUTH_LINE} onDone={(token) => finishReauth(token)} onClose={() => finishReauth(null)} />

      {toast ? (
        // 320px에서 긴 안내(승인 요청·재인증 실패)가 화면 밖으로 넘치지 않게 폭을 묶고 글자를 끊는다
        <div className="toast" role="status" style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 20, maxWidth: 'calc(100vw - 48px)', overflowWrap: 'anywhere' }}>
          {toast}
        </div>
      ) : null}
    </>
  );
}
