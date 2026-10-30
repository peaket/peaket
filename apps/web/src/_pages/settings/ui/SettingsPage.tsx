// SCR-017 계정 설정(d5 §5.17, 캔버스 보드 SCR-017-m·t·d를 한 페이지 반응형으로 합쳤다).
// 섹션: 프로필(⑦) → 휴대폰 본인확인(①) → 로그인한 기기(②, CMP-052) → 로그인 수단(③ → SCR-040)·예매 제한(→ SCR-042) → 알림 수신(④ → SCR-054) → 개인정보(⑤ → SCR-057) → 회원 탈퇴(⑥).
// 휴대폰은 섹션 목록(사이에 회색 띠), 태블릿(md 768)은 카드 2열 격자, 데스크톱(lg 1280, 본문 1040)은 왼쪽 메뉴(3칸) + 오른쪽 카드(9칸).
// 탈퇴 뒤 화면(완료·미룸·결제 확정 대기)은 본문 자리를 바꾼다. 겹침 창은 SettingsFlows(클라이언트)가 연다. 상태는 ?state=, 다크는 ?theme=dark.
import Link from 'next/link';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ME } from '@/entities/me';
import { formatWon } from '@/entities/production';
import { SCR017_STATES } from '@/shared/config/screens.account';
import { cx } from '@/shared/lib/cx';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import {
  DEVICE_SESSIONS,
  LINKED_PROVIDERS,
  PROFILE,
  PROVIDER_INFO,
  REMOTE_LOGGED_OUT_ID,
  RESTRICTION,
  withdrawQuote,
  type WithdrawQuote,
} from '../model/account';
import { settingsView, type SettingsDone } from '../model/state';
import { CopyCodeButton, SettingsDevices, SettingsFlows, WithdrawStartButton } from './SettingsFlows';

/** 휴대폰은 맨 섹션, 태블릿부터 카드(키트 .card와 같은 테두리·모서리) */
const CARD = 'md:rounded-(--r-xl) md:border md:border-solid md:border-(--border) md:bg-(--surface)';
/** 섹션 안쪽 여백(휴대폰 24·16 → 카드 20·24) */
const PAD = 'px-4 py-6 md:px-6 md:py-5';
const SETTINGS_PATH = '/my/settings';
const PROVIDERS_HREF = '/my/settings/providers';
const PRIVACY_HREF = '/policy/privacy';
const ALERTS_HREF = '/my/likes?tab=alerts';

export async function SettingsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR017_STATES, '기본');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = settingsView(state);
  const provider = PROVIDER_INFO[ME.provider];
  const quote = withdrawQuote();
  const initial = v.overlay && v.overlay.kind !== 'logout' ? v.overlay : null;

  return (
    // 탈퇴를 마치면 로그인 전 셸로 보인다(추천안). 접수(미룸)·결제 확정 대기는 계정이 남아 있다(보드 SCR-017-d '탈퇴 접수(미룸)')
    <AppShell dark={dark} guest={v.done === 'done'} defaultOpen={v.overlay?.kind === 'logout' ? 'logout' : null}>
      <SettingsFlows
        initial={initial}
        devices={DEVICE_SESSIONS}
        removedIds={v.remoteLoggedOut ? [REMOTE_LOGGED_OUT_ID] : []}
        devicesLoading={v.devicesLoading}
        toastOnMount={v.remoteLoggedOut ? 'Safari · iPhone에서 로그아웃했습니다' : undefined}
        provider={provider}
        quote={quote}
        dark={dark}
      >
        <main className="page-main" id="main" tabIndex={-1}>
          {v.done ? <DoneView done={v.done} quote={quote} /> : <AccountView restricted={v.restricted} providerLabel={provider.label} />}
        </main>
      </SettingsFlows>
      <PreviewSwitcher path={SETTINGS_PATH} states={SCR017_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}

function Gap() {
  return <div className="section-gap md:hidden" aria-hidden="true" />;
}

function AccountView({ restricted, providerLabel }: { restricted: boolean; providerLabel: string }) {
  return (
    <div className="pb-10 md:px-6 md:pt-6 md:pb-12 lg:mx-auto lg:grid lg:w-full lg:max-w-[1040px] lg:grid-cols-12 lg:items-start lg:gap-x-6 lg:px-8 lg:pt-8 lg:pb-16">
      <SideMenu />
      <div className="col md:gap-4 lg:col-span-9 lg:gap-5">
        <div className="col px-4 pt-5 pb-2 md:px-0 md:pt-0 lg:pb-0" style={{ gap: 4 }}>
          <h1 className="t-xl md:text-[32px] md:leading-[42px] md:tracking-[-.01em]">계정 설정</h1>
          <p className="t-sm muted">
            {ME.name} · {providerLabel}로 로그인했습니다
          </p>
        </div>

        <div className="col md:grid md:grid-cols-2 md:gap-4 lg:gap-5">
          <ProfileSection />
          <Gap />
          <VerifySection />
          <Gap />
          <DevicesSection providerLabel={providerLabel} />
          <Gap />
          <ProvidersSection />
          <Gap />
          <RestrictionSection restricted={restricted} />
          <Gap />
          <NotificationSection />
          <Gap />
          <PrivacySection />
          <Gap />
          <WithdrawSection />
        </div>
      </div>
    </div>
  );
}

/** 데스크톱 왼쪽: 프로필 요약 + 계정 설정 메뉴(섹션 바로가기) */
function SideMenu() {
  const items = [
    { href: '#h-profile', icon: 'user', label: '프로필' },
    { href: '#h-verify', icon: 'shield', label: '휴대폰 본인확인' },
    { href: '#h-dev', icon: 'device', label: '로그인한 기기' },
    { href: PROVIDERS_HREF, icon: 'key', label: '로그인 수단·계정 합치기' },
    { href: '#h-limit', icon: 'ban', label: '예매 제한' },
    { href: '#h-noti', icon: 'bell', label: '알림 수신' },
    { href: PRIVACY_HREF, icon: 'doc', label: '개인정보 처리방침' },
    { href: '#h-del', icon: 'logout', label: '회원 탈퇴' },
  ];
  return (
    <div className="hidden lg:col-span-3 lg:flex lg:flex-col" style={{ gap: 20 }}>
      <div className="row" style={{ gap: 12 }}>
        <span className="avatar" style={{ width: 44, height: 44, fontSize: 16 }} aria-hidden="true">
          {ME.avatarText}
        </span>
        <span className="col" style={{ gap: 4, alignItems: 'flex-start' }}>
          <strong className="t-md fw-b">{ME.name}</strong>
          {ME.verified ? (
            <span className="badge badge-success">
              <i className="ic ic-check" aria-hidden="true" />
              본인확인 완료
            </span>
          ) : null}
        </span>
      </div>
      <nav className="col" style={{ gap: 2 }} aria-label="계정 설정 메뉴">
        {items.map((it, i) =>
          it.href.startsWith('#') ? (
            <a key={it.label} className={cx('menu-item', i === 0 && 'is-active')} href={it.href} aria-current={i === 0 ? 'true' : undefined}>
              <i className={`ic ic-${it.icon} ic-16`} aria-hidden="true" />
              {it.label}
            </a>
          ) : (
            <Link key={it.label} className="menu-item" href={it.href}>
              <i className={`ic ic-${it.icon} ic-16`} aria-hidden="true" />
              {it.label}
            </Link>
          ),
        )}
      </nav>
    </div>
  );
}

function ProfileSection() {
  return (
    <section className={cx('col gap-1 px-4 pt-3 pb-6 md:col-span-2 md:gap-0 md:px-6 md:pt-5 md:pb-1', CARD)} aria-labelledby="h-profile">
      <div className="section-title md:pb-1">
        <h2 id="h-profile">프로필</h2>
      </div>
      <ul className="col md:grid md:grid-cols-2 md:gap-x-8">
        <li className="li">
          <span className="col grow" style={{ gap: 2 }}>
            <span className="li-sub">닉네임</span>
            <span className="li-title">{PROFILE.nickname}</span>
          </span>
          <button className="btn btn-outline btn-sm" type="button" aria-label="닉네임 바꾸기">
            바꾸기
          </button>
        </li>
        <li className="li">
          <span className="col grow" style={{ gap: 2 }}>
            <span className="li-sub">내 회원 코드</span>
            <span className="li-title mono">{PROFILE.memberCode}</span>
            <span className="li-sub">티켓을 양도받을 때 보내는 분에게 알려 주는 코드입니다</span>
          </span>
          <CopyCodeButton code={PROFILE.memberCode} />
        </li>
        <li className="li md:border-b-0">
          <span className="col grow" style={{ gap: 2 }}>
            <span className="li-sub">연락처</span>
            <span className="li-title num">{PROFILE.phoneMasked}</span>
            <span className="li-sub">바꾸기 전에 {PROVIDER_INFO[ME.provider].label}로 다시 로그인합니다</span>
          </span>
          <button className="btn btn-outline btn-sm" type="button" aria-label="연락처 바꾸기">
            바꾸기
          </button>
        </li>
        <li className="li md:border-b-0">
          <span className="li-title grow">저장된 예매자 정보</span>
          {/* 관리 화면은 아직 정본 경로가 없다(d5 §5.17 ⑦) */}
          <button className="btn btn-outline btn-sm" type="button" aria-label="저장된 예매자 정보 관리">
            관리
          </button>
        </li>
      </ul>
    </section>
  );
}

function VerifySection() {
  return (
    <section className={cx('col gap-3 md:col-span-2', PAD, CARD)} aria-labelledby="h-verify">
      <div className="section-title">
        <h2 id="h-verify">휴대폰 본인확인</h2>
        {ME.verified ? (
          <span className="badge badge-success">
            <i className="ic ic-check" aria-hidden="true" />
            완료
          </span>
        ) : null}
      </div>
      <dl className="kv md:hidden">
        <dt>인증한 날</dt>
        <dd>{PROFILE.verifiedAt}</dd>
      </dl>
      <p className="t-sm muted md:hidden">계정당 한 번 인증합니다.</p>
      <div className="row between hidden md:flex">
        <span className="t-sm">
          <span className="muted">인증한 날</span> <span className="num fw-b">{PROFILE.verifiedAt}</span>
        </span>
        <span className="t-sm muted">계정당 한 번 인증합니다.</span>
      </div>
    </section>
  );
}

function DevicesSection({ providerLabel }: { providerLabel: string }) {
  return (
    <section className={cx('col gap-2 md:col-span-2', PAD, CARD)} aria-labelledby="h-dev">
      <div className="section-title">
        <h2 id="h-dev">로그인한 기기</h2>
        <span className="t-sm muted">최대 5대</span>
      </div>
      <SettingsDevices />
      <div className="banner banner-info" style={{ marginTop: 8 }}>
        <i className="ic ic-info" aria-hidden="true" />
        <div className="banner-body">휴대폰에서 로그아웃해도 스캐너 세션은 따로 끝내야 합니다</div>
      </div>
      <p className="t-xs muted row" style={{ gap: 6 }}>
        <i className="ic ic-shield ic-14" aria-hidden="true" />
        다른 기기 로그아웃·스캐너 세션 끝내기 전에 {providerLabel}로 다시 로그인합니다
      </p>
    </section>
  );
}

function ProvidersSection() {
  const labels = LINKED_PROVIDERS.map((p) => PROVIDER_INFO[p].label).join(' · ');
  return (
    <section className={cx('col gap-3.5', PAD, CARD)} aria-labelledby="h-prov">
      <div className="section-title">
        <h2 id="h-prov">로그인 수단</h2>
      </div>
      <div className="row" style={{ gap: 8 }}>
        {LINKED_PROVIDERS.map((p) => (
          <span key={p} className={`btn ${PROVIDER_INFO[p].btn}`} aria-hidden="true" style={{ width: 36, minHeight: 36, padding: 0 }}>
            <i className={`prov ${PROVIDER_INFO[p].prov}`} />
          </span>
        ))}
        <span className="t-md grow" style={{ marginLeft: 4 }}>
          {labels} 연결됨
        </span>
      </div>
      <Link className="link-more" href={PROVIDERS_HREF}>
        로그인 수단·계정 합치기
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </Link>
    </section>
  );
}

function RestrictionSection({ restricted }: { restricted: boolean }) {
  return (
    <section className={cx('col gap-2.5', PAD, CARD)} aria-labelledby="h-limit">
      <div className="section-title">
        <h2 id="h-limit">예매 제한</h2>
        {restricted ? (
          <span className="badge badge-danger">
            제한 중 · 소명 기한 <span className="num">{RESTRICTION.appealDeadlineText}</span>
          </span>
        ) : (
          <span className="badge">없음</span>
        )}
      </div>
      {restricted ? (
        <Link className="link-more" href={RESTRICTION.appealHref}>
          소명하기
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      ) : (
        <p className="t-sm muted">제한이 생기면 이유와 소명 기한을 이메일로 알려 드리고, 여기에서 소명할 수 있습니다.</p>
      )}
    </section>
  );
}

function NotificationSection() {
  return (
    <section
      className={cx('col gap-1 px-4 py-6 md:col-span-2 md:gap-0 md:px-6 md:pt-5 md:pb-1 lg:col-span-1 lg:self-start', CARD)}
      aria-labelledby="h-noti"
    >
      <div className="section-title md:pb-1">
        <h2 id="h-noti">알림 수신</h2>
      </div>
      <ul className="col">
        <li className="li">
          <label className="li-title grow" htmlFor="sw-open">
            오픈·취소표 알림
          </label>
          {/* 태블릿은 신청 목록 링크를 이 줄 안에 둔다(보드 SCR-017-t) */}
          <Link className="link-more hidden md:inline-flex lg:hidden" href={ALERTS_HREF} style={{ marginRight: 12 }}>
            신청 목록
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
          <input className="sw" type="checkbox" role="switch" id="sw-open" defaultChecked />
        </li>
        <li className="li md:hidden lg:flex" style={{ minHeight: 44, padding: '8px 0' }}>
          <Link className="link-more" href={ALERTS_HREF}>
            오픈·취소표 신청 목록
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </li>
        <li className="li md:border-b-0">
          <label className="li-title grow" htmlFor="sw-mkt">
            마케팅 알림 <span className="t-sm muted">(선택)</span>
          </label>
          <input className="sw" type="checkbox" role="switch" id="sw-mkt" />
        </li>
      </ul>
    </section>
  );
}

function PrivacySection() {
  return (
    <section className={cx('col gap-1 px-4 py-6 md:self-start md:px-6 md:pt-5 md:pb-2', CARD)} aria-labelledby="h-privacy">
      <div className="section-title">
        <h2 id="h-privacy">개인정보</h2>
      </div>
      <Link className="li md:border-b-0" href={PRIVACY_HREF} style={{ color: 'inherit' }}>
        <span className="li-title grow">개인정보 처리방침</span>
        <i className="ic ic-chevron-right" aria-hidden="true" />
      </Link>
    </section>
  );
}

function WithdrawSection() {
  return (
    <section
      className={cx('col gap-3 px-4 pt-6 pb-2 md:self-start md:px-6 md:py-5 lg:col-span-2 lg:flex-row lg:items-center lg:gap-6 lg:self-auto lg:p-6', CARD)}
      aria-labelledby="h-del"
    >
      <div className="col gap-3 lg:grow lg:gap-1.5">
        <div className="section-title">
          <h2 id="h-del" className="tx-danger">
            회원 탈퇴
          </h2>
        </div>
        <p className="t-sm muted">탈퇴하면 주문·결제 기록은 법에 따라 5년간 분리 보관 후 파기됩니다</p>
      </div>
      <WithdrawStartButton className="btn btn-danger-outline btn-block lg:w-auto" />
    </section>
  );
}

/** 탈퇴 뒤 화면: 완료 · 접수(미룸) · 접수(결제 확정 대기) */
function DoneView({ done, quote }: { done: SettingsDone; quote: WithdrawQuote }) {
  const title = done === 'done' ? '탈퇴했습니다' : '탈퇴를 접수했습니다';
  const body =
    done === 'done'
      ? '환급은 3영업일 안에 결제한 수단으로 돌아갑니다. 언제든 다시 가입할 수 있습니다'
      : done === 'deferred'
        ? '결제 결과·환급이 끝나면 처리하고 이메일로 알려 드립니다. 그동안 새 예매와 양도는 할 수 없습니다.'
        : '결제 결과가 나온 뒤 탈퇴가 처리됩니다(보통 10분 안)';
  return (
    <div className="col gap-6 px-4 pt-14 pb-6 md:mx-auto md:w-full md:max-w-[480px] md:px-0 md:py-20 lg:py-24">
      <div className="state" role="status" style={{ padding: 0 }}>
        <span className={done === 'done' ? 'state-icon is-success' : 'state-icon'}>
          <i className={done === 'done' ? 'ic ic-check-circle' : 'ic ic-clock'} aria-hidden="true" />
        </span>
        <h1 className="t-xl lg:text-[32px] lg:leading-[42px] lg:tracking-[-.01em]">{title}</h1>
        <p className="t-md muted">{body}</p>
      </div>
      {done === 'done' ? (
        <>
          <section className="card-flat" style={{ padding: 16 }} aria-label="환급 예정">
            <dl className="kv">
              <dt>취소한 티켓</dt>
              <dd>{quote.ticketCount}장</dd>
              <dt>환급 예정 금액</dt>
              <dd>{formatWon(quote.refund)}</dd>
              <dt>돌려받는 곳</dt>
              <dd>결제한 수단</dd>
            </dl>
          </section>
          <p className="t-sm muted">주문·결제 기록은 법에 따라 5년간 분리 보관 후 파기됩니다</p>
        </>
      ) : null}
      <Link className="btn btn-primary btn-lg btn-block" href="/">
        홈으로 가기
      </Link>
    </div>
  );
}
