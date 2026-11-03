// SCR-054 관심 공연·알림 신청(d5 §5.28, 캔버스 보드 SCR-054-m·t·d를 한 페이지 반응형으로 합쳤다).
// ① 탭(관심 공연·알림 신청) ② 관심 공연 카드(공연 단위, 찜 해제) ③ 알림 신청 카드(끄기·밤 웹 푸시·끝난 까닭) ④ 오프라인 저장 대기 띠 ⑤ 알림 권한 설정(CMP-068).
// 휴대폰 1열 → 태블릿(md 768) 2열 → 데스크톱(lg 1280, 본문 1040) 관심 공연 3열·알림 2열. 상태는 ?state=(보드 state 값), 다크는 ?theme=dark.
// 계정 설정의 '오픈·취소표 신청 목록' 링크(?tab=alerts)로 들어오면 알림 신청 탭을 먼저 연다(추천안).
import Link from 'next/link';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ProductionPoster } from '@/entities/production';
import { SCR054_STATES } from '@/shared/config/screens.account';
import { firstParam, type PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { activeAlertCount, alertItems, likeCards, type AlertItem, type LikeCard } from '../model/lists';
import { likesView } from '../model/state';
import { AlertActionButton, LikesTabs, PermissionSettingsButton, UnlikeButton } from './LikesClient';

export async function LikesPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const fromSettings = firstParam(sp, 'state') === undefined && firstParam(sp, 'tab') === 'alerts';
  const state = fromSettings ? '알림 신청 탭' : resolvePreviewState(sp, SCR054_STATES, '관심 공연');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = likesView(state);
  const likes = v.empty ? [] : likeCards(v.offline);
  const alerts = v.empty ? [] : alertItems(v.endedSample);
  const pendingCount = likes.filter((c) => c.pending).length;

  return (
    <AppShell dark={dark}>
      <main
        className="page-main gap-5 px-4 pt-4 pb-10 md:px-6 md:pt-6 md:pb-12 lg:mx-auto lg:w-full lg:max-w-[1040px] lg:gap-6 lg:px-8 lg:pt-8 lg:pb-16"
        id="main"
        tabIndex={-1}
      >
        <h1 className="t-xl">관심 공연·알림 신청</h1>
        <LikesTabs
          initial={v.tab}
          likesBadge={v.empty ? undefined : likes.length}
          alertsBadge={v.empty ? undefined : activeAlertCount(alerts)}
          likesPanel={likes.length === 0 ? <LikesEmpty /> : <LikesPanel cards={likes} offline={v.offline} pendingCount={pendingCount} />}
          alertsPanel={alerts.length === 0 ? <AlertsEmpty /> : <AlertsPanel items={alerts} />}
        />
      </main>
      <PreviewSwitcher path="/my/likes" states={SCR054_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}

function LikesPanel({ cards, offline, pendingCount }: { cards: LikeCard[]; offline: boolean; pendingCount: number }) {
  return (
    <>
      {offline ? (
        <div className="banner banner-offline" role="status" style={{ marginBottom: 12 }}>
          <i className="ic ic-wifi-off" aria-hidden="true" />
          <div className="banner-body">
            <span className="banner-title">인터넷 연결이 없습니다</span>
            연결되면 저장됩니다(오프라인에서 누른 찜 {pendingCount}건)
          </div>
        </div>
      ) : null}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-3 lg:gap-6">
        {cards.map((c) => (
          <li key={c.id}>
            <article className="card flex gap-3.5 p-3.5 md:h-full lg:gap-4 lg:p-4">
              <ProductionPoster
                art={c.art}
                size="sm"
                label={`${c.title} 포스터`}
                title={c.posterShort}
                className="w-[72px] md:w-[88px] lg:w-24"
                style={{ alignSelf: 'flex-start' }}
              />
              <div className="col grow" style={{ gap: 6 }}>
                <h2 className="t-md fw-b">
                  {c.href ? (
                    <Link href={c.href} style={{ color: 'inherit' }}>
                      {c.title}
                    </Link>
                  ) : (
                    c.title
                  )}
                </h2>
                <p className="t-sm muted">{c.sub}</p>
                <div className="row between" style={{ gap: 8, marginTop: 'auto' }}>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <span className={c.badge.cls}>{c.badge.text}</span>
                    {c.pending ? (
                      <span className="badge badge-warning">
                        <i className="ic ic-clock" aria-hidden="true" />
                        저장 대기
                      </span>
                    ) : null}
                  </div>
                  <UnlikeButton title={c.title} />
                </div>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}

function AlertsPanel({ items }: { items: AlertItem[] }) {
  return (
    <div className="col" style={{ gap: 16 }}>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:gap-x-6">
        {items.map((a) => (
          <li key={a.id} className="card flex items-center gap-3 px-4 py-3.5 lg:gap-4 lg:px-5 lg:py-4">
            <div className="col grow" style={{ gap: 4 }}>
              <p className="t-md fw-b">{a.title}</p>
              <p className="t-sm muted">{a.when}</p>
              <div className="row wrap" style={{ gap: '4px 8px' }}>
                <span className={a.endedText ? 'badge' : 'badge badge-primary'}>
                  <i className={`ic ic-${a.kindIcon}`} aria-hidden="true" />
                  {a.kindLabel}
                </span>
                {a.endedText ? <span className="badge">끝남</span> : <span className="t-xs muted">{a.channel}</span>}
              </div>
              {a.endedText ? (
                <p className="t-xs">{a.endedText}</p>
              ) : (
                <label className="check-row">
                  <input className="cb" type="checkbox" defaultChecked={a.nightPush} />
                  <span className="t-xs">
                    밤(21:00~08:00)에도 웹 푸시 받기<span className="sr-only"> ({a.srLabel})</span>
                  </span>
                </label>
              )}
            </div>
            {!a.endedText || a.resubscribe ? <AlertActionButton srLabel={a.srLabel} kindLabel={a.kindLabel} ended={Boolean(a.endedText)} /> : null}
          </li>
        ))}
      </ul>
      <p className="t-xs muted">밤(21:00~08:00)에는 &apos;밤에도 웹 푸시 받기&apos;를 켠 신청만 웹 푸시로 알리고, 끈 신청은 이메일로만 알립니다.</p>
      <PermissionSettingsButton />
    </div>
  );
}

function LikesEmpty() {
  return (
    <div className="state" style={{ padding: '56px 16px' }}>
      <span className="state-icon">
        <i className="ic ic-heart" aria-hidden="true" />
      </span>
      <h2 className="t-lg">관심 공연이 없습니다</h2>
      <Link className="btn btn-secondary" href="/search">
        공연 둘러보기
      </Link>
    </div>
  );
}

function AlertsEmpty() {
  return (
    <div className="state" style={{ padding: '56px 16px' }}>
      <span className="state-icon">
        <i className="ic ic-bell" aria-hidden="true" />
      </span>
      <h2 className="t-lg">신청한 알림이 없습니다</h2>
    </div>
  );
}
