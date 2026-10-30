// SCR-061 내 현장 배정(d5 §5.35, d3 SCR-061 행, 캔버스 보드 SCR-061-m·t·d를 한 페이지 반응형으로 합쳤다).
// 한 열: 현재 배정 카드(배지 진행 중·곧 시작·해제, 파트너·권한 유효 시간, 지금 로그인한 스캐너) → 지난 배정(종료) → 스캐너 로그인 방법 안내.
// 휴대폰은 바탕 위에 바로 쌓고, md 768부터 옅은 바탕(surface-basement) 가운데 560 폭으로 바뀐다. 셸은 스태프 변형(하늘 = 현장 책임자).
// 상태는 ?state=(보드 state 값), 다크는 ?theme=dark.
import Link from 'next/link';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ME_HANEUL } from '@/entities/me';
import { ProductionPoster } from '@/entities/production';
import { ORIGINS } from '@/shared/config/origins';
import { SCR061_STATES } from '@/shared/config/screens.account';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { currentAssignmentCard, pastAssignmentCards, staffHomeView, type AssignmentCard } from '../model/state';

const PATH = '/staff';
/** 닫기는 홈으로 간다(추천안) */
const CLOSE_HREF = '/';

export async function StaffHomePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR061_STATES, '기본');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = staffHomeView(state);
  const now = v.nowPhase ? currentAssignmentCard(v.nowPhase) : null;
  const past = v.past ? pastAssignmentCards() : [];

  return (
    <AppShell variant="staff" staff={{ closeHref: CLOSE_HREF }} user={ME_HANEUL} dark={dark}>
      <main
        className="page-main px-4 pt-6 pb-10 md:bg-(--surface-basement) md:px-6 md:pt-10 md:pb-14 lg:px-8 lg:pt-12 lg:pb-16"
        id="main"
        tabIndex={-1}
      >
        <div className="col mx-auto w-full max-w-[560px] gap-7">
          <h1 className="t-xl">내 현장 배정</h1>

          {v.loading ? (
            <div className="card col" style={{ gap: 12, padding: 16 }} aria-busy="true">
              <p className="sr-only" role="status">
                배정을 불러오는 중입니다
              </p>
              <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                <span className="skel" style={{ width: 56, height: 75, flex: 'none' }} />
                <div className="col grow" style={{ gap: 8 }}>
                  <span className="skel" style={{ height: 22, width: '45%' }} />
                  <span className="skel" style={{ height: 20, width: '85%' }} />
                  <span className="skel" style={{ height: 16, width: '60%' }} />
                </div>
              </div>
              <hr className="divider" />
              <span className="skel" style={{ height: 16 }} />
              <span className="skel" style={{ height: 16 }} />
              <span className="skel" style={{ height: 16, width: '65%' }} />
            </div>
          ) : null}

          {now ? (
            <section className="col" aria-labelledby="now-h" style={{ gap: 12 }}>
              <h2 className="t-md fw-b" id="now-h">
                현재 배정
              </h2>
              <CurrentCard card={now} />
            </section>
          ) : null}

          {past.length > 0 ? (
            <section className="col" aria-labelledby="past-h" style={{ gap: 12 }}>
              <h2 className="t-md fw-b" id="past-h">
                지난 배정
              </h2>
              {past.map((p) => (
                <article key={p.id} className="card row items-start gap-3 px-4 py-[14px] md:gap-4 md:px-5 md:py-4 lg:px-6" aria-labelledby={`${p.id}-t`}>
                  <ProductionPoster art={p.posterArt} size="sm" title={p.posterShort} label={`${p.title} 포스터`} style={{ width: 56 }} />
                  <div className="col grow" style={{ gap: 6 }}>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <span className={p.phaseBadge}>{p.phaseLabel}</span>
                      <span className="badge badge-outline">{p.roleLabel}</span>
                    </div>
                    <h3 className="t-md fw-b" id={`${p.id}-t`}>
                      {p.title}
                    </h3>
                    <p className="t-sm muted">{p.sub}</p>
                  </div>
                </article>
              ))}
            </section>
          ) : null}

          {v.guide ? (
            <div className="banner banner-info">
              <i className="ic ic-scan" aria-hidden="true" />
              <div className="banner-body">
                <span className="banner-title">스캐너에 로그인하는 방법</span>
                {/* 퍼블리싱 흐름 잇기: 스캐너 앱의 로그인 화면(SCR-036, 기기 승인 QR). 실제로는 다른 기기라 링크가 없다 */}
                <a className="link" href={`${ORIGINS.scanner}/login`}>
                  스캐너 화면
                </a>
                의 QR을 휴대폰 카메라로 찍으면{' '}
                <Link className="link" href="/staff/approve">
                  승인 화면
                </Link>
                이 열립니다.
              </div>
            </div>
          ) : null}

          {v.empty ? (
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
      <PreviewSwitcher path={PATH} states={SCR061_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}

/** 현재 배정 카드: 머리(포스터·배지·공연명·회차·공연장) · 구분선 · 파트너·권한 유효 시간 + 배지별 아래 줄 */
function CurrentCard({ card }: { card: AssignmentCard }) {
  return (
    <article className="card" aria-labelledby="a1-t">
      <div className="row items-start gap-3 px-4 pt-4 pb-[14px] md:gap-4 md:px-5 md:pt-5 md:pb-4 lg:px-6">
        <ProductionPoster art={card.posterArt} size="sm" title={card.posterShort} label={`${card.title} 포스터`} className="w-14 md:w-16" />
        <div className="col grow" style={{ gap: 6 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            <span className={card.phaseBadge}>{card.phaseLabel}</span>
            <span className="badge badge-outline">{card.roleLabel}</span>
          </div>
          <h3 className="t-md fw-b md:text-[20px] md:leading-[27px]" id="a1-t">
            {card.title}
          </h3>
          <p className="t-sm muted">{card.sub}</p>
        </div>
      </div>
      <hr className="divider" />
      <div className="col gap-3 px-4 pt-[14px] pb-4 md:gap-[14px] md:px-5 md:pt-4 md:pb-5 lg:px-6">
        <dl className="kv">
          <dt>파트너</dt>
          <dd>{card.partnerName}</dd>
          <dt>권한 유효 시간</dt>
          <dd>{card.validText}</dd>
        </dl>
        {card.phase === 'active' && card.scannerName ? (
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
