// 실제 값 화면(ctx.live)에서 ui/live 부품을 데이터와 잇는 작은 자리들(F-03-3 OPS-380).
// - 위젯 값: 위젯 조회(GET /v1/ops/widgets/{key}, 처음 그릴 때) + 위젯 흐름(보이는 동안) — 원격 위젯과 같은 통로(slotFor)
// - T-30분 점검: GET /v1/ops/events/{eventId}/readiness로 처음 채우고 위젯 키 ops-readiness.checklist로 항목·미리 보기를 바꾼다. 판정은 POST …/go-no-go-judgements
// - 경보 패널·배너: 호스트 alerts·control 슬라이스(늘 여는 흐름)
// 서버 그리기·첫 그림에서는 효과가 돌기 전이라 '불러오는 중' 자리를 그린다.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { WidgetKey } from '@peaket/console-contract';
import { ensureConsoleApi } from '@/shared/api';
import { slotFor } from '@/shared/api/live';
import { recentRange } from '@/shared/lib/links';
import { useLiveHost } from '@/shared/model/live-host';
import { BudgetWidget, type BudgetValue } from './BudgetWidget';
import { ControlBanner } from './ControlBanner';
import { DiagnosticsRow, type DiagnosticsValue } from './DiagnosticsRow';
import { JudgementDialog } from './JudgementDialog';
import { LiveAlertPanel } from './LiveAlertPanel';
import { ReadinessChecklist, type Readiness } from './ReadinessChecklist';
import { SaturationWidget, type SaturationValue } from './SaturationWidget';
import { DetailAnchor, fmt, JudgementLine, kst, PendingCard } from './frame';

/** 위젯 키 하나의 지금 값(없으면 undefined = 아직 받지 않음) */
export function useWidgetValue<T>(key: string, eventId: string | null): T | undefined {
  const slot = useMemo(() => slotFor(`live-${key}`), [key]);
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => () => slot.dispose(), [slot]);
  useEffect(() => {
    let alive = true;
    setValue(undefined);
    slot.services.data
      .query<T>(key as WidgetKey, { eventId })
      .then((v) => {
        if (alive) setValue((cur) => cur ?? v);
      })
      .catch(() => undefined);
    const stop = slot.services.data.subscribe<T>(key as WidgetKey, {}, (v) => {
      if (alive) setValue(v);
    });
    return () => {
      alive = false;
      stop();
    };
  }, [slot, key, eventId]);
  return value;
}

export function LiveBudgetSlot({ eventId, id }: { eventId: string | null; id: string }) {
  const value = useWidgetValue<BudgetValue>('ops-budget.journeys', eventId);
  return <BudgetWidget id={id} value={value ?? { error: 'source-unavailable', eventId }} range={recentRange()} loading={value === undefined} />;
}

export function LiveSaturationSlot({ eventId, id }: { eventId: string | null; id: string }) {
  const value = useWidgetValue<SaturationValue>('ops-saturation.summary', eventId);
  return <SaturationWidget id={id} value={value ?? { error: 'source-unavailable', eventId }} range={recentRange()} loading={value === undefined} />;
}

export function LiveDiagnosticsSlot({ eventId, id }: { eventId: string | null; id: string }) {
  const value = useWidgetValue<DiagnosticsValue>('ops-diagnostics.summary', eventId);
  return <DiagnosticsRow id={id} value={value ?? { error: 'source-unavailable', eventId }} range={recentRange()} loading={value === undefined} />;
}

export function LiveAlertSlot({ style }: { style?: CSSProperties }) {
  const alerts = useLiveHost((s) => s.alerts);
  const eventId = useLiveHost((s) => s.scope.eventId);
  return <LiveAlertPanel alerts={alerts} eventId={eventId} style={style} />;
}

export function LiveControlBanner() {
  const control = useLiveHost((s) => s.control);
  return <ControlBanner control={control} />;
}

const CONTROL_TEXT: Record<string, string> = {
  ok: '정상',
  paused: '일시정지',
  'raise-stopped': '자동 증액 멈춤',
  'no-input': '입력 없음',
  'emergency-stop': '긴급 정지',
  unknown: '받지 못함',
};

/** T=0 탭 '자동 제어' 위젯(호스트 control 슬라이스) */
export function LiveControlCard({ eventId }: { eventId: string | null }) {
  const c = useLiveHost((s) => s.control);
  const tone = c.kind === 'ok' ? 'slo slo-ok' : c.kind === 'unknown' ? 'slo slo-stale' : c.kind === 'raise-stopped' || c.kind === 'paused' ? 'slo slo-burning' : 'slo slo-breached';
  return (
    <section className="widget" role="region" aria-labelledby="w-ctl">
      <div className="widget-head wrap">
        <h2 className="t-sm fw-b" id="w-ctl">
          자동 제어
        </h2>
        <div className="actions" style={{ gap: 12 }}>
          <span className={tone}>{CONTROL_TEXT[c.kind] ?? '받지 못함'}</span>
          <DetailAnchor title="자동 제어" panel="control" eventId={eventId} range={recentRange()} />
        </div>
      </div>
      <div className="widget-body grow" style={{ gap: 6 }}>
        <ul className="col t-xs" style={{ gap: 6 }}>
          <li className="row between">
            <span>지금 동시 입장 목표</span>
            <span className="num">{typeof c.targetNow === 'number' ? `${fmt(c.targetNow)}명` : '—'}</span>
          </li>
          {c.since ? (
            <li className="row between">
              <span>입력 없음 시작</span>
              <span className="num">{kst(c.since)}</span>
            </li>
          ) : null}
          {c.inputStaleKinds && c.inputStaleKinds.length > 0 ? (
            <li className="row between">
              <span>없는 입력</span>
              <span>{c.inputStaleKinds.join('·')}</span>
            </li>
          ) : null}
          {c.budgetHoldAt ? (
            <li className="row between">
              <span>버짓 연동 감축</span>
              <span className="num">{kst(c.budgetHoldAt)}</span>
            </li>
          ) : null}
          <li className="row between">
            <span>읽은 시각</span>
            <span className="num">{c.updatedAt ? kst(c.updatedAt) : '—'}</span>
          </li>
        </ul>
        <JudgementLine widgetKey="ops-control.status" />
      </div>
    </section>
  );
}

/** 원천 연결 전 카드(시각 범위는 지금 기준) */
export function LivePending(p: { id: string; title: string; origin: string; eventId: string | null; kind?: 'grafana' | 'sentry'; style?: CSSProperties }) {
  return <PendingCard {...p} range={recentRange()} />;
}

const problemText = (e: unknown): string => {
  const p = e as { status?: number; data?: { type?: string; title?: string } } | null;
  const type = String(p?.data?.type ?? '');
  if (type.endsWith('/judgement-window-closed')) return '판정 창(오픈 30분 전~20분 전) 밖이라 기록하지 않았습니다';
  if (type.endsWith('/recommended-reason-required')) return '실패한 권고 항목의 사유를 적어 주세요';
  if (p?.status === 403) return '이 역할로는 판정할 수 없습니다';
  return p?.data?.title ?? '판정을 기록하지 못했습니다. 잠시 뒤 다시 시도해 주세요';
};

/** T-30분 점검 탭(체크리스트·판정 자리·대화상자) */
export function LiveReadinessPanel({ eventId, role }: { eventId: string | null; role: string | null | undefined }) {
  const [readiness, setReadiness] = useState<Readiness | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const live = useWidgetValue<{ items?: Readiness['items']; preview?: Readiness['preview']; error?: string }>('ops-readiness.checklist', eventId);

  useEffect(() => {
    let alive = true;
    if (!eventId || !ensureConsoleApi()) return undefined;
    void import('@peaket/api-client/endpoints/ops')
      .then(({ getOpsEventReadiness }) => getOpsEventReadiness(eventId))
      .then((r) => {
        if (alive) {
          setReadiness(r.data as unknown as Readiness);
          setFailed(false);
        }
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [eventId, reload]);

  // 위젯 흐름의 항목·미리 보기로 바꾼다(원천 실패 값이면 그대로 둔다)
  const shown: Readiness | undefined = readiness && live && Array.isArray(live.items) && live.preview ? { ...readiness, items: live.items, preview: live.preview } : readiness;

  const submit = async (recommendedReasons: Record<string, string>) => {
    if (!eventId || !ensureConsoleApi()) return;
    setBusy(true);
    setError(undefined);
    try {
      const { createOpsGoNoGoJudgement } = await import('@peaket/api-client/endpoints/ops');
      await createOpsGoNoGoJudgement(eventId, { recommendedReasons });
      setOpen(false);
      setReload((n) => n + 1);
    } catch (e) {
      setError(problemText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!shown) {
    return (
      <section className="widget" role="region" aria-labelledby="w-pf" style={{ gridColumn: '1 / -1' }}>
        <div className="widget-head wrap">
          <h2 className="t-sm fw-b" id="w-pf">
            T-30분 점검
          </h2>
          <div className="actions">
            <DetailAnchor title="T-30분 점검" panel="readiness" eventId={eventId} range={recentRange()} />
          </div>
        </div>
        <div className="widget-body">
          <p className="t-xs muted" role="status">
            {failed ? '점검 값을 받지 못했습니다(core-svc 판매 설정·지표 창고). 잠시 뒤 다시 읽습니다.' : '점검 값을 불러오는 중입니다…'}
          </p>
        </div>
      </section>
    );
  }
  return (
    <>
      <ReadinessChecklist readiness={shown} role={role} onJudge={() => setOpen(true)} />
      {open ? <JudgementDialog readiness={shown} onSubmit={(r) => void submit(r)} onClose={() => setOpen(false)} busy={busy} {...(error ? { error } : {})} /> : null}
    </>
  );
}
