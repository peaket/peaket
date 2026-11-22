'use client';
// SCR-061 실제 화면(d5 §5.35, BUILD_ORDER F-05-7 = GAT-240, ADR-0362, I-T93).
// 차례: GET /v1/staff-assignments(첫 쪽 limit 50) → 배정마다 회차 공개 요약 → 배지·칸을 지금 시각으로 정한다(model/live.ts). nextCursor가 있으면 [더 보기]가 다음 쪽을 이어 붙인다.
// 401(갱신도 401)은 /login?next=/staff, 그 밖 실패는 '못 불러옴'과 [다시 불러오기]다.
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { browserEventSummaryReader } from '@/entities/event-summary/browser';
import { readEventSummaries, type EventSummaryAnswer } from '@/entities/event-summary';
import type { StaffAssignmentSelf } from '@/entities/staff-assignment';
import { browserStaffInvitationApi } from '@/features/staff-invitation/browser';
import { ORIGINS } from '@/shared/config/origins';
import { loginHrefAfterRefresh } from '@/shared/lib/token-refresh';
import { AppShell } from '@/widgets/app-shell';
import { type LiveAssignmentCard, staffHomeLiveView, type StaffHomeLiveState } from '../model/live';

const PATH = '/staff';
const CLOSE_HREF = '/';

export function StaffHomeLive() {
  const api = useMemo(() => browserStaffInvitationApi(), []);
  const events = useMemo(() => browserEventSummaryReader(), []);
  const [state, setState] = useState<StaffHomeLiveState>('조회 중');
  const [items, setItems] = useState<StaffAssignmentSelf[]>([]);
  const [summaries, setSummaries] = useState<ReadonlyMap<string, EventSummaryAnswer>>(new Map());
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');

  /** 한 쪽을 읽고 요약을 채운다. append면 [더 보기] */
  const page = useCallback(
    async (from: string | null, append: boolean) => {
      const r = await api.listAssignments(from);
      if (r.kind === 'login') {
        window.location.assign(loginHrefAfterRefresh(PATH));
        return false;
      }
      if (r.kind !== 'ok') return false;
      const read = await readEventSummaries(events, r.items.map((a) => a.eventId));
      setSummaries((m) => new Map([...(append ? m : new Map()), ...read]));
      setItems((prev) => (append ? [...prev, ...r.items] : r.items));
      setCursor(r.nextCursor);
      return true;
    },
    [api, events],
  );

  const reload = useCallback(async () => {
    setState('조회 중');
    setMore('idle');
    const ok = await page(null, false);
    setState(ok ? '기본' : '못 불러옴');
  }, [page]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadMore = async () => {
    if (!cursor || more === 'loading') return;
    setMore('loading');
    setMore((await page(cursor, true)) ? 'idle' : 'error');
  };

  const v = staffHomeLiveView(items, summaries, Date.now());
  const empty = state === '기본' && v.empty;

  return (
    <AppShell variant="staff" staff={{ closeHref: CLOSE_HREF }}>
      <main className="page-main px-4 pt-6 pb-10 md:bg-(--surface-basement) md:px-6 md:pt-10 md:pb-14 lg:px-8 lg:pt-12 lg:pb-16" id="main" tabIndex={-1}>
        <div className="col mx-auto w-full max-w-[560px] gap-7">
          <h1 className="t-xl">내 현장 배정</h1>

          {state === '조회 중' ? <LoadingCard /> : null}

          {state === '못 불러옴' ? (
            <div className="card state px-5 py-7 md:px-8 md:py-9" role="alert">
              <span className="state-icon is-warning">
                <i className="ic ic-alert" aria-hidden="true" />
              </span>
              <h2 className="t-lg">현장 근무를 불러오지 못했습니다</h2>
              <button className="btn btn-secondary btn-lg btn-block md:w-auto md:min-w-[240px]" type="button" onClick={() => void reload()}>
                다시 불러오기
              </button>
            </div>
          ) : null}

          {state === '기본' && v.current.length > 0 ? (
            <section className="col" aria-labelledby="now-h" style={{ gap: 12 }}>
              <h2 className="t-md fw-b" id="now-h">
                현재 배정
              </h2>
              {v.current.map((c) => (
                <CurrentCard key={c.id} card={c} />
              ))}
            </section>
          ) : null}

          {state === '기본' && v.past.length > 0 ? (
            <section className="col" aria-labelledby="past-h" style={{ gap: 12 }}>
              <h2 className="t-md fw-b" id="past-h">
                지난 배정
              </h2>
              {v.past.map((p) => (
                <article key={p.id} className="card row items-start gap-3 px-4 py-[14px] md:gap-4 md:px-5 md:py-4 lg:px-6" aria-labelledby={`${p.id}-t`}>
                  <div className="col grow" style={{ gap: 6 }}>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <span className={p.phaseBadge}>{p.phaseLabel}</span>
                      <span className="badge badge-outline">{p.roleLabel}</span>
                    </div>
                    <h3 className="t-md fw-b" id={`${p.id}-t`}>
                      {p.title ?? '공연 정보를 불러오지 못했습니다'}
                    </h3>
                    <p className="t-sm muted">{p.sub || p.validText}</p>
                    {p.phase === 'revoked' ? <p className="t-sm">파트너가 배정을 해제했습니다.</p> : null}
                  </div>
                </article>
              ))}
            </section>
          ) : null}

          {state === '기본' && cursor ? (
            <div className="col items-center" style={{ gap: 8 }}>
              {more === 'error' ? (
                <p className="t-sm muted" role="status">
                  현장 근무를 불러오지 못했습니다
                </p>
              ) : null}
              <button className="btn btn-outline" type="button" aria-busy={more === 'loading' || undefined} onClick={() => void loadMore()}>
                더 보기
              </button>
            </div>
          ) : null}

          {state === '기본' && v.guide ? (
            <div className="banner banner-info">
              <i className="ic ic-scan" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">스캐너에 로그인하는 방법</span>
                <a className="link" href={`${ORIGINS.scanner}/login`}>
                  스캐너 화면
                </a>
                의 QR을 휴대폰 카메라로 찍으면 승인 화면이 열립니다.
              </div>
            </div>
          ) : null}

          {empty ? (
            <div className="state" style={{ padding: '56px 16px' }}>
              <span className="state-icon">
                <i className="ic ic-calendar" aria-hidden="true" />
              </span>
              <h2 className="t-lg">배정된 현장 근무가 없습니다</h2>
              <p className="t-sm muted">파트너가 보낸 초대 이메일의 링크로 초대를 수락하면 여기에 보입니다.</p>
              <Link className="btn btn-secondary" href="/">
                홈으로 가기
              </Link>
            </div>
          ) : null}
        </div>
      </main>
    </AppShell>
  );
}

interface CurrentCardProps {
  card: LiveAssignmentCard;
}

/** 현재 배정 카드: 머리(배지·역할·공연명·회차) · 구분선 · 파트너·권한 유효 시간 + 배지별 아래 줄 */
function CurrentCard({ card }: CurrentCardProps) {
  return (
    <article className="card" aria-labelledby={`${card.id}-t`}>
      <div className="col px-4 pt-4 pb-[14px] md:px-5 md:pt-5 md:pb-4 lg:px-6" style={{ gap: 6 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className={card.phaseBadge}>{card.phaseLabel}</span>
          <span className="badge badge-outline">{card.roleLabel}</span>
        </div>
        <h3 className="t-md fw-b md:text-[20px] md:leading-[27px]" id={`${card.id}-t`}>
          {card.title ?? '공연 정보를 불러오지 못했습니다'}
        </h3>
        {card.sub ? <p className="t-sm muted">{card.sub}</p> : null}
      </div>
      <hr className="divider" />
      <div className="col gap-3 px-4 pt-[14px] pb-4 md:gap-[14px] md:px-5 md:pt-4 md:pb-5 lg:px-6">
        <dl className="kv">
          {card.partnerName ? (
            <>
              <dt>파트너</dt>
              <dd>{card.partnerName}</dd>
            </>
          ) : null}
          <dt>권한 유효 시간</dt>
          <dd>{card.validText}</dd>
        </dl>
        {card.scannerName ? (
          <div className="card-flat row gap-[10px] px-3 py-[10px] md:px-[14px] md:py-3">
            <i className="ic ic-device" aria-hidden="true" />
            <span className="t-sm muted grow">지금 로그인한 스캐너</span>
            <strong className="t-md">{card.scannerName}</strong>
          </div>
        ) : null}
        {card.phase === 'soon' ? (
          <div className="banner banner-info">
            <i className="ic ic-clock" aria-hidden="true" />
            <div className="banner-body">권한 유효 시간 전에는 스캐너에 로그인할 수 없습니다. {card.validFromText}부터 로그인할 수 있습니다.</div>
          </div>
        ) : null}
        {card.phase === 'revoked' ? (
          <div className="banner banner-warning" role="status">
            <i className="ic ic-alert" aria-hidden="true" />
            <div className="banner-body">파트너가 배정을 해제했습니다.</div>
          </div>
        ) : null}
      </div>
    </article>
  );
}

/** 조회 중: 카드 뼈대 */
function LoadingCard() {
  return (
    <div className="card col" style={{ gap: 12, padding: 16 }} aria-busy="true">
      <p className="sr-only" role="status">
        배정을 불러오는 중입니다
      </p>
      <span className="skel" style={{ height: 22, width: '45%' }} />
      <span className="skel" style={{ height: 20, width: '85%' }} />
      <hr className="divider" />
      <span className="skel" style={{ height: 16 }} />
      <span className="skel" style={{ height: 16, width: '65%' }} />
    </div>
  );
}
