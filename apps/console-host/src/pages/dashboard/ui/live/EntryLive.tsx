'use client';
// 관제 입장 탭(SCR-029 tab=entry)의 실제 값(F-05-8 GAT-360).
// - 회차 단계·입장 시작·마감: ops-svc GET /v1/ops/events/{eventId}/readiness.
// - 스캐너 신선도(SEV2)·중복 입장 급증(SEV3): ops-svc GET /v1/ops/alerts?eventId=의 기존 경보 원천.
// 값이 없거나 2분을 넘으면 '세지 못함'/'늦음'과 까닭을 보이고, 관제는 감시만 한다.
import { useCallback, useEffect, useState } from 'react';
import { ensureConsoleApi, opsApiAvailable } from '@/shared/api';
import { entryAlertsOf, entryScheduleOf, entryStageOf, staleText, type EntryAlert, type EntrySchedule } from '../../model/entry-live';

const ops = () => import('@peaket/api-client/endpoints/ops');

const STAGE_TEXT: Record<string, string> = { before: '입장 전', open: '입장 중', closed: '입장 마감', unknown: '세지 못함' };
const KST = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const kst = (iso: string | null): string => {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '세지 못함';
  return `${KST.format(new Date(iso))} KST`;
};

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; schedule: EntrySchedule; alerts: EntryAlert[]; alertsUnavailable?: string }
  | { kind: 'unavailable'; text: string };

export function EntryLive({ eventId }: { eventId: string | null }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const nowMs = Date.now();

  const run = useCallback(async (): Promise<void> => {
    if (!eventId) {
      setLoad({ kind: 'unavailable', text: '회차를 고르면 입장 값을 읽습니다' });
      return;
    }
    if (!ensureConsoleApi() || !opsApiAvailable()) {
      setLoad({ kind: 'unavailable', text: '관제 API 주소가 없어 입장 값을 세지 못합니다' });
      return;
    }
    setLoad({ kind: 'loading' });
    try {
      const { getOpsEventReadiness, listOpsAlerts } = await ops();
      const [r, a] = await Promise.all([getOpsEventReadiness(eventId), listOpsAlerts({ eventId }).catch(() => null)]);
      const schedule = entryScheduleOf(r.data);
      if (a === null) setLoad({ kind: 'ready', schedule, alerts: [], alertsUnavailable: '입장 경보를 읽지 못했습니다' });
      else setLoad({ kind: 'ready', schedule, alerts: entryAlertsOf(a.data) });
    } catch {
      setLoad({ kind: 'unavailable', text: '회차 단계를 읽지 못했습니다(관제 API 응답 없음)' });
    }
  }, [eventId]);

  useEffect(() => {
    void run();
  }, [run]);

  if (load.kind === 'loading') {
    return (
      <p className="t-sm muted" role="status" aria-live="polite">
        입장 값을 불러오는 중입니다…
      </p>
    );
  }
  if (load.kind === 'unavailable') {
    return (
      <div className="banner banner-warning" role="status">
        <i className="ic ic-alert-circle" aria-hidden="true" />
        <div className="banner-body">
          <span className="banner-title">입장 값을 세지 못함</span>
          {load.text}
        </div>
      </div>
    );
  }

  const stage = entryStageOf(load.schedule, nowMs);
  const stale = load.alerts.filter((x) => x.kind === 'SCANNER_STALE');
  const surge = load.alerts.filter((x) => x.kind === 'DUPLICATE_SURGE');
  const late = stale.filter((x) => staleText(x.ageMs ?? undefined, x.thresholdMs ?? 120_000).late).length;

  return (
    <div className="col" role="tabpanel" id="panel-entry" aria-labelledby="tab-entry" style={{ gap: 12 }}>
      <p className="row t-sm muted" style={{ gap: 8 }}>
        <i className="ic ic-info ic-16" aria-hidden="true" />
        관제는 감시만 합니다. 이상 표시 처리·예외 통과·기기 배치는 현장 책임자와 파트너가 합니다.
      </p>
      <div role="group" aria-label="입장 일정과 경보" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
        <div className="stat">
          <span className="stat-label">현재 단계</span>
          <span className="stat-value">{STAGE_TEXT[stage] ?? '세지 못함'}</span>
          <span className="stat-meta">{load.schedule.unavailable ?? 'ops-svc 회차 단계'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">입장 시작</span>
          <span className="stat-value">{kst(load.schedule.entryOpensAt)}</span>
          <span className="stat-meta">{load.schedule.entryOpensAt ? 'core-svc 판매 설정의 입장 창' : '세지 못함'}</span>
        </div>
        <div className="stat">
          <span className="stat-label">입장 마감</span>
          <span className="stat-value">{load.schedule.entryClosedAt ? kst(load.schedule.entryClosedAt) : '아직 마감 전'}</span>
          <span className="stat-meta">{load.schedule.entryClosedAt ? '마감 시각이 정해졌습니다' : '입장 기록 마감 전이거나 일정이 없습니다'}</span>
        </div>
        <div className={`stat${late > 0 ? ' is-breached' : ''}`}>
          <span className="stat-label">늦은 스캐너</span>
          <span className="stat-value">{stale.length === 0 ? '0대' : `${stale.length}대`}</span>
          <span className={`slo ${late > 0 ? 'slo-breached' : 'slo-ok'}`}>{late > 0 ? '기준 2분 초과 · SEV2' : '모두 기준 안'}</span>
          <span className="stat-meta">{load.alertsUnavailable ?? '마지막 변경분 수신 기준'}</span>
        </div>
      </div>

      {load.schedule.unavailable ? (
        <div className="banner banner-warning" role="status">
          <i className="ic ic-clock" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">입장 일정을 세지 못함</span>
            {load.schedule.unavailable}
          </div>
        </div>
      ) : null}
      {load.alertsUnavailable ? (
        <div className="banner banner-warning" role="status">
          <i className="ic ic-clock" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">입장 경보를 세지 못함</span>
            {load.alertsUnavailable}
          </div>
        </div>
      ) : null}

      {load.alerts.length === 0 ? (
        <p className="t-sm muted" role="status">
          지금 열린 스캐너 신선도·중복 입장 급증 경보가 없습니다.
        </p>
      ) : (
        <ul className="col" style={{ gap: 8 }} aria-label="입장 경보">
          {stale.map((a, i) => {
            const age = staleText(a.ageMs ?? undefined, a.thresholdMs ?? 120_000);
            return (
              <li key={`stale-${i}`} className={`banner ${age.late ? 'banner-warning' : 'banner-info'}`} role="status">
                <i className="ic ic-wifi-off" aria-hidden="true" />
                <div className="banner-body">
                  <span className="banner-title">{a.severity} · 스캐너 동기화 {age.late ? '늦음' : '경보'}</span>
                  {[a.deviceName, a.gateZone].filter(Boolean).join(' · ') || '기기 이름 없음'} · {age.text}
                  {a.startsAt ? ` · 시작 ${kst(a.startsAt)}` : ''}
                </div>
              </li>
            );
          })}
          {surge.map((a, i) => (
            <li key={`surge-${i}`} className="banner banner-warning" role="status">
              <i className="ic ic-flag" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">{a.severity} · 중복 입장 급증</span>
                {a.count !== null ? `중복 입장 ${a.count}건` : '건수를 세지 못함'}
                {a.thresholdMs !== null ? ` · 기준 ${Math.floor(a.thresholdMs / 60_000)}분 ${a.thresholdMs % 60_000 === 0 ? '10건' : ''}` : ''}
                {a.startsAt ? ` · 시작 ${kst(a.startsAt)}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
