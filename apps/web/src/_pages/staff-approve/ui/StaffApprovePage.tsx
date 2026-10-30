// SCR-051 스캐너 승인(휴대폰 쪽)(d5 §5.27, d3 SCR-051 행, 캔버스 보드 SCR-051-m·t·d와 흐름 보드 FLOW-staff-login ⑤⑥을 한 페이지 반응형으로 합쳤다).
// 스캐너(SCR-036)의 QR을 스태프가 자기 휴대폰으로 찍으면 열린다. 한 열: 설명 → ① 경고 → ② 기기 카드 → ③ 확인 코드 → ④ 내 배정 → ⑥ 대리 승인 → ⑤ 승인·거부.
// 휴대폰은 바탕 위에 바로 쌓고, md 768부터 옅은 바탕(surface-basement) 가운데 560 폭으로 바뀐다. 셸은 스태프 변형(하늘 = 현장 책임자, 로그인 필요는 로그인 전 모양).
// 실제 화면은 주소의 #code= 조각을 읽고 지운다(d5 §5.27). 퍼블리싱 단계라 상태는 ?state=(보드 state 값), 다크는 ?theme=dark.
import Link from 'next/link';
import { previewHref, resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ME_HANEUL } from '@/entities/me';
import { STAFF_ROLE_LABEL } from '@/entities/staff-assignment';
import { ORIGINS } from '@/shared/config/origins';
import { SCR051_STATES } from '@/shared/config/screens.account';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { approvalModel, codeLabel, STAFF_DOYUN } from '../model/approval';
import { approveView, type DenyReason } from '../model/state';
import { ApproveForm } from './ApproveForm';

const PATH = '/staff/approve';
/** 닫기는 내 현장 배정으로 간다(추천안: d5에 닫은 뒤 갈 곳이 없고, 스태프 화면의 첫 화면이 SCR-061이다) */
const CLOSE_HREF = '/staff';
/** 로그인 뒤 같은 탭으로 돌아온다. next에는 경로만 넣는다(#code= 조각은 넣지 않는다, d5 §5.27) */
const LOGIN_HREF = `/login?next=${encodeURIComponent(PATH)}`;

/** 상태 카드 둘레: 휴대폰 보드 28/20 · 36/20, md 이상은 태블릿 보드 36/32 · 44/32 */
const CARD = 'card state px-5 py-7 md:px-8 md:py-9';
const CARD_TALL = 'card state px-5 py-9 md:px-8 md:py-11';

const DENY_TITLE: Record<Exclude<DenyReason, 'off-hours' | 'proxy'>, string> = {
  'no-assignment': '이 회차에 배정되지 않았습니다',
  'other-partner': '이 기기는 다른 파트너의 기기입니다',
};

export async function StaffApprovePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR051_STATES, '승인 대기');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const keep = { theme: dark ? 'dark' : undefined };
  const v = approveView(state);
  const m = approvalModel();
  const account = v.introAs === 'staff' ? STAFF_DOYUN : ME_HANEUL;
  const accountRole = STAFF_ROLE_LABEL[v.introAs === 'staff' ? 'gate_staff' : 'gate_lead'];

  return (
    <AppShell variant="staff" staff={{ closeHref: CLOSE_HREF }} user={account} guest={!v.signedIn} dark={dark}>
      <main
        className="page-main px-4 pt-6 pb-10 md:bg-(--surface-basement) md:px-6 md:pt-10 md:pb-14 lg:px-8"
        id="main"
        tabIndex={-1}
      >
        <div className="col mx-auto w-full max-w-[560px] flex-1 gap-5">
          <h1 className="t-xl">스캐너 승인</h1>

          {v.introAs ? (
            <p className="t-md">
              스캐너에 뜬 QR을 내 휴대폰 카메라로 찍으면 이 화면이 열립니다. 승인하면 그 스캐너가 내 계정({account.name} · {accountRole})으로
              로그인됩니다.
            </p>
          ) : null}

          {v.mode === 'login' ? (
            <section className="card state px-5 py-8 md:px-8 md:py-10" aria-labelledby="li-h">
              <span className="state-icon is-primary">
                <i className="ic ic-user" aria-hidden="true" />
              </span>
              <h2 className="t-lg" id="li-h">
                스캐너에 로그인하려면 먼저 이 휴대폰에서 피켓에 로그인하세요
              </h2>
              <Link className="btn btn-primary btn-lg btn-block" href={LOGIN_HREF} aria-describedby="li-hint">
                로그인
              </Link>
              <p className="hint" id="li-hint">
                로그인 뒤 같은 탭으로 돌아와 이어갑니다
              </p>
            </section>
          ) : null}

          {v.warning ? (
            <div className="banner banner-warning" role="status">
              <i className="ic ic-alert" aria-hidden="true" />
              <div className="banner-body fw-b">현장 스캐너에 로그인하려고 합니다</div>
            </div>
          ) : null}

          {v.mode === 'loading' ? <LoadingSkeleton /> : null}

          {v.device ? (
            <section className="card col gap-[14px] p-4 md:p-5 lg:px-6" aria-labelledby="dv-h">
              <div className="row gap-3 md:gap-[14px]">
                <span className="state-icon is-primary size-12 md:size-[52px]">
                  <i className="ic ic-device" aria-hidden="true" />
                </span>
                <h2 className="t-lg" id="dv-h">
                  이 기기는 {m.deviceName}입니다
                </h2>
              </div>
              <dl className="kv">
                <dt>배정 파트너</dt>
                <dd>{v.partnerKnown ? <span>{m.partnerName}</span> : <span className="muted">이름을 불러오지 못했습니다</span>}</dd>
              </dl>
            </section>
          ) : null}

          {v.mode === 'ready' ? (
            <div className="col flex-1 gap-5">
              {/* ③ 확인 코드. 휴대폰은 옅은 면(card-flat), md 이상은 바탕이 옅어져 테두리 카드(card)로 바뀐다(보드) */}
              <section
                className="card-flat col items-center gap-2 px-4 py-5 text-center md:border md:border-(--border) md:bg-(--surface) md:px-5 md:py-6 lg:px-6"
                aria-labelledby="cd-h"
              >
                <h2 className="t-sm fw-b muted" id="cd-h">
                  확인 코드
                </h2>
                <p className="code-display" role="img" aria-label={codeLabel(m.code)}>
                  {m.code}
                </p>
                <p className="t-sm">스캐너 화면의 코드가 {m.code}와 같을 때만 승인하세요.</p>
              </section>

              <ApproveForm
                key={state}
                deviceName={m.deviceName}
                single={
                  v.pick === 'single' ? (v.partnerKnown ? { title: m.single.show, meta: m.single.meta } : { title: m.singleCompact }) : undefined
                }
                options={v.pick === 'multi' ? m.options : undefined}
                canProxy={v.pick === 'single'}
                defaultProxy={v.proxy}
                accountName={ME_HANEUL.name}
                approvedHref={previewHref(PATH, '승인됨', keep)}
                rejectedHref={previewHref(PATH, '거부함', keep)}
              />
            </div>
          ) : null}

          {v.mode === 'denied' && v.deny ? (
            <div className={CARD} role="alert">
              <span className="state-icon is-danger">
                <i className="ic ic-ban" aria-hidden="true" />
              </span>
              {v.deny === 'no-assignment' || v.deny === 'other-partner' ? <h2 className="t-lg">{DENY_TITLE[v.deny]}</h2> : null}
              {v.deny === 'off-hours' ? (
                <div className="col items-center" style={{ gap: 8 }}>
                  <h2 className="t-lg">운영 시간 밖입니다</h2>
                  <p className="t-sm">권한 유효 시간 안에서만 승인할 수 있습니다.</p>
                  <p className="t-sm muted">내 권한 유효 시간 {m.validText}</p>
                </div>
              ) : null}
              {v.deny === 'proxy' ? (
                <div className="col items-center" style={{ gap: 8 }}>
                  <h2 className="t-lg">대리 승인 권한이 없습니다</h2>
                  <p className="t-sm">현장 책임자만 대신 승인할 수 있습니다.</p>
                </div>
              ) : null}
              <p className="t-sm muted">지금 로그인한 계정: {account.name}</p>
              <Link className="btn btn-secondary btn-lg btn-block md:w-auto md:min-w-[240px]" href="/staff">
                내 현장 배정 보기
              </Link>
            </div>
          ) : null}

          {v.mode === 'approved' ? (
            <div className={CARD_TALL} role="alert">
              <span className="state-icon is-success">
                <i className="ic ic-check-circle" aria-hidden="true" />
              </span>
              <h2 className="t-lg">승인했습니다</h2>
              {/* 퍼블리싱 흐름 잇기: 승인된 스캐너는 근무 준비(SCR-033)로 간다. 실제로는 다른 기기라 이 줄에 링크가 없다 */}
              <p className="t-md">
                <a className="link" href={`${ORIGINS.scanner}/setup`}>
                  스캐너 화면
                </a>
                을 확인하세요.
              </p>
              <p className="t-sm muted">{m.approvedText}</p>
            </div>
          ) : null}

          {v.mode === 'rejected' ? (
            <div className={CARD_TALL} role="alert">
              <span className="state-icon">
                <i className="ic ic-ban" aria-hidden="true" />
              </span>
              <h2 className="t-lg">거부했습니다</h2>
              <p className="t-sm muted">스캐너의 코드는 쓸 수 없게 됩니다.</p>
            </div>
          ) : null}

          {v.mode === 'expired' ? (
            <div className={CARD_TALL} role="alert">
              <span className="state-icon is-warning">
                <i className="ic ic-clock" aria-hidden="true" />
              </span>
              <h2 className="t-lg">확인 코드가 만료되었습니다</h2>
              {/* 퍼블리싱 흐름 잇기: 스캐너 로그인 화면(SCR-036, 기기 승인 QR). 실제로는 다른 기기라 링크가 없다 */}
              <p className="t-sm muted">
                스캐너에서{' '}
                <a className="link" href={`${ORIGINS.scanner}/login`}>
                  새 QR
                </a>
                을 띄워 주세요.
              </p>
            </div>
          ) : null}

          {v.mode === 'limited' ? (
            <div className={CARD_TALL} role="alert">
              <span className="state-icon is-warning">
                <i className="ic ic-alert" aria-hidden="true" />
              </span>
              <h2 className="t-lg">승인 시도가 너무 많습니다</h2>
              <p className="t-sm muted">잠시 뒤 다시 시도하세요.</p>
            </div>
          ) : null}
        </div>
      </main>
      <PreviewSwitcher path={PATH} states={SCR051_STATES} current={state} keep={keep} />
    </AppShell>
  );
}

/** 조회 중: 기기 카드와 확인 코드 뼈대(휴대폰 보드 크기, md 이상은 태블릿 보드 크기) */
function LoadingSkeleton() {
  return (
    <div className="col" style={{ gap: 16 }} aria-busy="true">
      <p className="t-sm muted" role="status">
        기기 정보를 확인하는 중입니다
      </p>
      <div className="card col gap-[14px] p-4 md:p-5 lg:px-6">
        <div className="row gap-3 md:gap-[14px]">
          <span className="skel size-12 flex-none rounded-full md:size-[52px]" />
          <span className="skel h-6 w-[65%] md:w-[55%]" />
        </div>
        <span className="skel h-4 w-[80%] md:w-[70%]" />
      </div>
      <div className="card-flat col items-center gap-[10px] px-4 py-5 md:border md:border-(--border) md:bg-(--surface) md:px-5 md:py-6 lg:px-6">
        <span className="skel h-[14px] w-[30%] md:w-[24%]" />
        <span className="skel h-11 w-[78%] md:w-[60%]" />
        <span className="skel h-4 w-[85%] md:w-[76%]" />
      </div>
    </div>
  );
}
