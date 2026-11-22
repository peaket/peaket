// SCR-050 화면 조각(d5 §5.26). 퍼블리싱 미리보기(StaffInvitationsPage, 서버)와 실제 흐름(StaffInvitationsLive, 클라이언트)이 같은 조각을 그린다.
// 훅을 쓰지 않는 부품이라 두 쪽에서 모두 그릴 수 있다. 함수 값(onReload·onRetry)은 실제 흐름만 넘긴다(미리보기는 누름이 없는 버튼).
// 초대 내용·고지 원문·이메일은 글자로만 그린다(HTML로 해석하지 않는다, ADR-0362 결정 2, ASVS 3.2.2).
import Link from 'next/link';
import { ProductionPoster, type PosterArt } from '@/entities/production';
import { VerifyIdentityButton } from '@/features/identity-verify';
import type { InvitationMode } from '../model/state';

/** 상태 카드(이유 화면) 둘레: 휴대폰 보드 28/20, md 이상은 SCR-051 태블릿 보드와 같은 36/32(추천안: 이 화면의 태블릿 보드에는 기본 상태만 있다) */
const STATE_CARD = 'card state px-5 py-7 md:px-8 md:py-9';

export interface InvitationSummaryCardProps {
  title: string;
  /** 목업 포스터(미리보기). 실제 흐름은 회차 공개 요약에 포스터가 없어 비운다 */
  poster?: { art: PosterArt; short: string };
  /** '10/25(일) 18:00 · 피켓 아레나' 또는 회차 시작 '10/25(일) 18:00' */
  whenWhere: string;
  /** 판매자 상호. null이면 '파트너 이름을 읽지 못함'(① 자리에 안내와 [다시 불러오기], 결정 3) */
  partnerName: string | null;
  roleLabel: string;
  validText: string;
  email: string;
  onReload?: () => void;
}

/** ① 초대 요약 카드: 공연명·회차(·공연장) · 파트너 · 역할 · 권한 유효 시간 · 초대 이메일 */
export function InvitationSummaryCard({ title, poster, whenWhere, partnerName, roleLabel, validText, email, onReload }: InvitationSummaryCardProps) {
  return (
    <article className="card" aria-labelledby="inv-t">
      {partnerName === null ? (
        <div className="col items-start gap-2 px-4 pt-4 pb-[14px] md:px-5 md:pt-5 md:pb-4 lg:px-6" role="alert">
          <h2 className="t-md fw-b" id="inv-t">
            초대한 파트너 정보를 불러오지 못했습니다
          </h2>
          <button className="btn btn-outline btn-sm" type="button" onClick={onReload}>
            다시 불러오기
          </button>
        </div>
      ) : (
        <div className="row items-start gap-3 px-4 pt-4 pb-[14px] md:gap-4 md:px-5 md:pt-5 md:pb-4 lg:px-6">
          {poster ? <ProductionPoster art={poster.art} size="sm" title={poster.short} label={`${title} 포스터`} className="w-14 md:w-16" /> : null}
          <div className="col grow" style={{ gap: 4 }}>
            <h2 className="t-md fw-b md:text-[20px] md:leading-[27px]" id="inv-t">
              {title}
            </h2>
            <p className="t-sm muted">{whenWhere}</p>
          </div>
        </div>
      )}
      <hr className="divider" />
      <dl className="kv px-4 pt-[14px] pb-3 md:px-5 md:pt-4 lg:px-6">
        {partnerName === null ? null : (
          <>
            <dt>파트너</dt>
            <dd>{partnerName}</dd>
          </>
        )}
        <dt>역할</dt>
        <dd>
          <span className="badge badge-primary">{roleLabel}</span>
        </dd>
        <dt>권한 유효 시간</dt>
        <dd>{validText}</dd>
        <dt>초대 이메일</dt>
        <dd>
          <span className="mono t-sm">{email}</span>
        </dd>
      </dl>
      <p className="t-xs muted px-4 pb-4 md:px-5 md:pb-[18px] lg:px-6">권한 유효 시간은 입장 시작 3시간 전부터 공연 종료 2시간 뒤까지입니다.</p>
    </article>
  );
}

export interface InvitationStateCardProps {
  mode: InvitationMode;
  /** 가린 초대 이메일(이메일 불일치) */
  email: string;
  /** 로그인 필요의 [로그인] 주소(next에는 경로만, d5 §5.26 끝 문단) */
  loginHref: string;
  /** 불러오지 못함의 [다시 불러오기](실제 흐름만) */
  onRetry?: () => void;
}

/** 이유·결과 화면(d5 §5.26 상태 표). 폼과 조회 중은 그리지 않는다 */
export function InvitationStateCard({ mode, email, loginHref, onRetry }: InvitationStateCardProps) {
  switch (mode) {
    case 'mismatch':
      return (
        <div className={STATE_CARD} role="alert">
          <span className="state-icon is-danger">
            <i className="ic ic-mail" aria-hidden="true" />
          </span>
          <h2 className="t-lg">초대 이메일과 계정 이메일이 다릅니다</h2>
          {/* 보드는 이 줄에 ha***@example.com을, 카드의 초대 이메일에 .org를 적었다. 이 줄은 초대 이메일을 말하므로 카드와 같은 주소로 맞췄다(추천안) */}
          <p className="t-sm">
            이 초대는 <span className="mono">{email}</span> 계정 이메일과 같아야 받을 수 있습니다. 이 계정 이메일로 다시 초대를 요청하세요.
          </p>
        </div>
      );
    case 'no-verified-email':
      return (
        <div className={STATE_CARD} role="alert">
          <span className="state-icon is-warning">
            <i className="ic ic-key" aria-hidden="true" />
          </span>
          <h2 className="t-lg">카카오나 구글 로그인 수단을 연결해야 받을 수 있습니다</h2>
          <p className="t-sm muted">이 계정은 네이버 로그인만 연결되어 있어 초대 이메일과 맞춰 볼 검증된 이메일이 없습니다.</p>
          <Link className="btn btn-primary btn-lg btn-block" href="/my/settings/providers">
            로그인 수단 연결하러 가기
          </Link>
        </div>
      );
    case 'need-identity':
      return (
        <div className={STATE_CARD} role="alert">
          <span className="state-icon is-warning">
            <i className="ic ic-shield" aria-hidden="true" />
          </span>
          <h2 className="t-lg">휴대폰 본인확인을 먼저 마쳐야 합니다</h2>
          <p className="t-sm muted">본인확인을 마친 계정만 초대를 받을 수 있습니다. 본인확인을 마치면 이 화면에서 수락을 이어 갑니다.</p>
          <p className="t-sm" id="nid-purpose">
            휴대폰 본인확인은 계정당 한 번만 합니다. 한 사람은 한 계정으로만 예매할 수 있습니다
          </p>
          {/* SCR-006 기관 창·결과 대화상자를 이 화면 위에서 연다 */}
          <VerifyIdentityButton className="btn btn-primary btn-lg btn-block" describedBy="nid-purpose">
            <i className="ic ic-phone" aria-hidden="true" />
            휴대폰 본인확인
          </VerifyIdentityButton>
        </div>
      );
    case 'expired':
      return (
        <div className="card state px-5 py-9 md:px-8 md:py-11" role="alert">
          <span className="state-icon is-warning">
            <i className="ic ic-clock" aria-hidden="true" />
          </span>
          <h2 className="t-lg">초대가 만료되었습니다</h2>
          <p className="t-sm muted">초대 링크는 받은 때부터 24시간 동안 한 번만 쓸 수 있습니다. 파트너에게 다시 요청하세요.</p>
        </div>
      );
    case 'assigned':
      return (
        <div className={STATE_CARD} role="alert">
          <span className="state-icon is-primary">
            <i className="ic ic-check-circle" aria-hidden="true" />
          </span>
          <h2 className="t-lg">이미 이 회차에 배정되어 있습니다</h2>
          <p className="t-sm muted">배정 내용과 권한 유효 시간은 내 현장 배정에서 볼 수 있습니다.</p>
          <Link className="btn btn-primary btn-lg btn-block" href="/staff">
            내 현장 배정 보기
          </Link>
        </div>
      );
    case 'login':
      return (
        <section className="card state px-5 py-8 md:px-8 md:py-10" aria-labelledby="li-h">
          <span className="state-icon is-primary">
            <i className="ic ic-user" aria-hidden="true" />
          </span>
          <h2 className="t-lg" id="li-h">
            초대를 받으려면 먼저 이 휴대폰에서 피켓에 로그인하세요
          </h2>
          <Link className="btn btn-primary btn-lg btn-block" href={loginHref} aria-describedby="li-hint">
            로그인
          </Link>
          <p className="hint" id="li-hint">
            로그인 뒤 같은 탭으로 돌아와 이어갑니다
          </p>
        </section>
      );
    case 'rejected':
      return (
        <div className="card state px-5 py-9 md:px-8 md:py-11" role="status">
          <span className="state-icon">
            <i className="ic ic-ban" aria-hidden="true" />
          </span>
          <h2 className="t-lg">초대를 거절했습니다</h2>
          <Link className="btn btn-secondary btn-lg btn-block md:w-auto md:min-w-[240px]" href="/">
            홈으로
          </Link>
        </div>
      );
    case 'error':
      // d5에 없는 조회 실패(5xx·연결 끊김). 토큰은 탭 저장소에 그대로 있어 다시 불러올 수 있다
      return (
        <div className={STATE_CARD} role="alert">
          <span className="state-icon is-warning">
            <i className="ic ic-alert" aria-hidden="true" />
          </span>
          <h2 className="t-lg">초대 정보를 불러오지 못했습니다</h2>
          <p className="t-sm muted">잠시 뒤 다시 시도해 주세요.</p>
          <button className="btn btn-secondary btn-lg btn-block md:w-auto md:min-w-[240px]" type="button" onClick={onRetry}>
            다시 불러오기
          </button>
        </div>
      );
    default:
      return null;
  }
}

/** 수락 완료(d5 §5.26): 안내 띠. 아래 [내 현장 배정 보기] 링크는 InvitationDoneLink */
export function InvitationDoneBanner() {
  return (
    <div className="banner banner-success" role="status">
      <i className="ic ic-check-circle" aria-hidden="true" />
      <div className="banner-body">
        <span className="banner-title">수락했습니다</span>
        입장 시작 3시간 전부터 스캐너에 로그인할 수 있습니다.
      </div>
    </div>
  );
}

export function InvitationDoneLink() {
  return (
    <Link className="btn btn-primary btn-lg btn-block" href="/staff">
      내 현장 배정 보기
    </Link>
  );
}

/** 조회 중: 초대 요약 카드와 동의 카드 뼈대(보드 그대로) */
export function InvitationLoadingSkeleton() {
  return (
    <div className="col" style={{ gap: 16 }} aria-busy="true">
      <p className="t-sm muted" role="status">
        초대 정보를 확인하는 중입니다
      </p>
      <div className="card col" style={{ gap: 12, padding: 16 }}>
        <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <span className="skel" style={{ width: 56, height: 75, flex: 'none' }} />
          <div className="col grow" style={{ gap: 8 }}>
            <span className="skel" style={{ height: 20, width: '85%' }} />
            <span className="skel" style={{ height: 16, width: '60%' }} />
          </div>
        </div>
        <hr className="divider" />
        <span className="skel" style={{ height: 16 }} />
        <span className="skel" style={{ height: 16 }} />
        <span className="skel" style={{ height: 16, width: '70%' }} />
      </div>
      <div className="card col" style={{ gap: 10, padding: 16 }}>
        <span className="skel" style={{ height: 20, width: '40%' }} />
        <span className="skel" style={{ height: 16 }} />
        <span className="skel" style={{ height: 16 }} />
        <span className="skel" style={{ height: 16, width: '60%' }} />
      </div>
    </div>
  );
}
