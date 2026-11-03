// SCR-026 실시간 판매 현황(/events/[id]/live). 보드 SCR-026-m·t·d·xl을 한 페이지 반응형으로 합쳤다(d5 §6.9, d3 SCR-026, §3.9).
// 휴대폰: 머리 세 줄(제목 · 회차 칩 · 갱신 표시등) · 타일 2열 · 그래프·격자 1열 / 태블릿: 타일 2열 / 데스크톱: 타일 4열 /
// xl 1440: 타일 6열(판매율·대기열 진입 누적을 따로) · 그래프와 격자를 2열로.
// 1분 주기 조회 모양이다: 갱신 표시등 '마지막 갱신 n초 전' <잠정>, 조회가 늦으면 '갱신 늦음'(타일 값은 마지막 값 그대로). 실제 조회는 데이터를 잇는 단계에서 붙인다.
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Skeleton, SkeletonGroup } from '@peaket/ds/Skeleton';
import { StatTile } from '@peaket/ds/StatTile';
import { requireProduction } from '@/entities/production';
import { routes } from '@/shared/config/routes';
import { LIVE_STATES } from '@/shared/config/states/scr026';
import { readParam, readPreview, type RouteProps, type SearchParams } from '@/shared/lib/preview';
import { PreviewStateSwitcher } from '@/shared/ui/PreviewStateSwitcher';
import { EventContextHeader } from '@/widgets/event-context';
import { AS_OF, AS_OF_BEFORE, LOBBY_AT, OPEN_AT, TILES, TILES_XL, type Tile } from '../model/live';
import { HeatGrid, HeatLegend, HeatTable } from './HeatGrid';
import { MinuteChart, MinuteTable } from './MinuteChart';
import { ToggleCard } from './ToggleCard';

/** 회차 칩 주소: 상태·테마·역할을 남기고 round만 바꾼다 */
function roundHref(base: string, sp: SearchParams, round: string): string {
  const q = new URLSearchParams();
  for (const k of ['state', 'theme', 'role'] as const) {
    const v = readParam(sp, k);
    if (v) q.set(k, v);
  }
  q.set('round', round);
  return `${base}?${q.toString()}`;
}

export default async function SalesLivePage({ params, searchParams }: RouteProps<{ id: string }>) {
  const { id } = await params;
  const sp = await searchParams;
  const pv = readPreview(sp, LIVE_STATES, '기본');
  const production = requireProduction(id);
  const base = routes.eventTab(id, 'live');

  const loading = pv.state === '로딩';
  const before = pv.state === '판매 전';
  const stale = pv.state === '갱신 늦음';
  const live = !loading && !before;

  const roundParam = readParam(sp, 'round');
  const rounds = production.rounds;
  const selected = roundParam === 'all' ? null : (rounds.find((r) => r.id === roundParam) ?? rounds[0] ?? null);
  const roundLabel = selected ? `${selected.startsAt} 회차` : '전체 회차';
  const report = routes.eventTab(id, 'settlement');

  return (
    <>
      <EventContextHeader production={production} current="live" />

      <section className="col" style={{ gap: 16 }} aria-labelledby="live-h">
        <div className="flex flex-col gap-2.5 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-3">
          <div className="flex flex-col gap-2.5 md:flex-row md:flex-wrap md:items-center md:gap-x-4">
            <h2 className="t-lg" id="live-h">
              실시간 판매 현황
            </h2>
            <nav className="row wrap" style={{ gap: 6 }} aria-label="회차 고르기">
              <Link
                className={selected ? 'chip chip-sm' : 'chip chip-sm is-selected'}
                href={roundHref(base, sp, 'all')}
                aria-current={selected ? undefined : 'page'}
                scroll={false}
              >
                전체 회차
              </Link>
              {rounds.map((r) => (
                <Link
                  key={r.id}
                  className={r.id === selected?.id ? 'chip chip-sm is-selected' : 'chip chip-sm'}
                  href={roundHref(base, sp, r.id)}
                  aria-current={r.id === selected?.id ? 'page' : undefined}
                  scroll={false}
                >
                  {r.startsAt}
                </Link>
              ))}
            </nav>
          </div>
          <div className="row wrap" style={{ gap: '6px 10px' }}>
            {!stale && !loading && (
              <span className="badge badge-success">
                <i className="ic ic-refresh" aria-hidden="true" />
                마지막 갱신 12초 전
              </span>
            )}
            {stale && (
              <span className="badge badge-warning max-md:whitespace-normal max-md:py-0.5" role="status">
                <i className="ic ic-alert" aria-hidden="true" />
                마지막 갱신 3분 넘게 전 · 다시 확인하는 중
              </span>
            )}
            <span className="badge badge-outline">잠정</span>
          </div>
        </div>

        {!loading && (
          <div className="banner banner-info" role="status">
            <i className="ic ic-info" aria-hidden="true" />
            <div className="banner-body">
              <span className="banner-title">약 1분 지연된 잠정 집계입니다. 확정 숫자는 판매 요약 리포트에서 봅니다</span>
              {before ? (
                <>
                  집계 기준 {AS_OF_BEFORE} · 오픈 전입니다(오픈 {OPEN_AT} · 로비 {LOBBY_AT})
                </>
              ) : (
                <>
                  집계 기준 {AS_OF} · 1분마다 갱신합니다 ·{' '}
                  <Link className="link" href={report}>
                    판매 요약 리포트
                  </Link>
                </>
              )}
            </div>
          </div>
        )}

        {loading ? <TileSkeletons /> : <TileGroups kind={before ? 'before' : 'live'} stale={stale} />}

        <div className="flex flex-col gap-4 xl:grid xl:grid-cols-2 xl:items-start xl:gap-5">
          <ToggleCard
            titleId="ch-h"
            title="분당 판매"
            sub={
              <>
                <span className="xl:hidden">{roundLabel} · </span>오픈 20:00 KST부터 1분 단위 판매 매수 · 최근 180분까지
              </>
            }
            chart={live ? <MinuteChart /> : loading ? <ChartSkeleton /> : <NoSales />}
            table={live ? <MinuteTable roundLabel={roundLabel} /> : loading ? <ChartSkeleton /> : <NoSales />}
          />
          <ToggleCard
            titleId="hm-h"
            title="구역별 잔여석"
            sub={
              <>
                구역<span className="xl:hidden"> 6곳</span> × 열 묶음(무대 쪽부터 3열씩) · 칸 숫자는 남은 좌석 수
              </>
            }
            chart={loading ? <HeatSkeleton /> : <HeatGrid before={before} />}
            table={loading ? <HeatSkeleton /> : <HeatTable before={before} />}
          >
            <HeatLegend />
          </ToggleCard>
        </div>

        <p className="t-xs muted">
          개인정보와 봇 탐지 정보는 보이지 않습니다. 판매 5건 [가정] 미만 칸은 합쳐 보이고, 다른 파트너사와 비교하지 않습니다. 확정 숫자는 회차가 끝난 뒤 판매 요약에서 봅니다.
        </p>
      </section>

      <PreviewStateSwitcher path={base} states={LIVE_STATES} current={pv.state} keep={{ ...pv.keep, round: roundParam }} />
    </>
  );
}

/* ---------- 숫자 타일(CMP-032) ---------- */

const PROVISIONAL = <span className="badge badge-outline">잠정</span>;

/** 휴대폰은 예상 매진 시각의 ' KST'를 작게(보드 SCR-026-m) */
function TileValue({ value }: { value: string }): ReactNode {
  if (!value.endsWith(' KST')) return value;
  return (
    <>
      {value.slice(0, -4)}
      <span className="t-sm fw-b md:hidden"> KST</span>
      <span className="max-md:hidden"> KST</span>
    </>
  );
}

/** 갱신 늦음: 타일 값은 마지막 값 그대로 두고 '갱신 멈춤 · 20:22 KST 값'(휴대폰은 두 줄) */
const STALE_TEXT = (
  <span>
    갱신 멈춤<span className="max-md:hidden"> · </span>
    <br className="md:hidden" />
    {AS_OF} 값
  </span>
);

function Tiles({ tiles, stale }: { tiles: readonly Tile[]; stale: boolean }) {
  return tiles.map((t) => (
    <StatTile
      key={t.label}
      label={t.label}
      value={<TileValue value={t.value} />}
      badge={PROVISIONAL}
      meta={t.meta}
      status={stale ? 'stale' : undefined}
      statusText={stale ? STALE_TEXT : undefined}
    />
  ));
}

const GRID_4 = 'grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4 xl:hidden';
const GRID_6 = 'hidden xl:grid xl:grid-cols-6 xl:gap-3';

function TileGroups({ kind, stale }: { kind: 'live' | 'before'; stale: boolean }) {
  return (
    <>
      <div className={GRID_4}>
        <Tiles tiles={TILES[kind]} stale={stale} />
      </div>
      <div className={GRID_6}>
        <Tiles tiles={TILES_XL[kind]} stale={stale} />
      </div>
    </>
  );
}

function SkeletonTile() {
  return (
    <div className="stat">
      <Skeleton height={14} width="40%" />
      <Skeleton height={30} width="70%" />
      <Skeleton height={12} width="85%" />
    </div>
  );
}

/** 로딩(첫 집계): 타일 스켈레톤 */
function TileSkeletons() {
  return (
    <>
      <SkeletonGroup label="첫 집계를 불러오는 중" className={GRID_4}>
        {[0, 1, 2, 3].map((i) => (
          <SkeletonTile key={i} />
        ))}
      </SkeletonGroup>
      <SkeletonGroup label="첫 집계를 불러오는 중" className={GRID_6}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <SkeletonTile key={i} />
        ))}
      </SkeletonGroup>
    </>
  );
}

/* ---------- 그래프·격자 자리 ---------- */

function ChartSkeleton() {
  return <Skeleton className="h-[184px] md:h-[200px]" />;
}

function HeatSkeleton() {
  return <Skeleton height={190} />;
}

function NoSales() {
  return (
    <div className="col center h-[184px] md:h-[200px]" style={{ gap: 6, textAlign: 'center' }}>
      <span className="t-sm muted">아직 판매 기록이 없습니다</span>
      <span className="t-xs muted">오픈 {OPEN_AT}부터 1분마다 쌓입니다</span>
    </div>
  );
}
