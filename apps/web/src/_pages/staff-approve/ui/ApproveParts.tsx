// SCR-051 화면 조각(d5 §5.27). 퍼블리싱 미리보기(StaffApprovePage, 서버)와 실제 흐름(StaffApproveLive, 클라이언트)이 같은 조각을 그린다.
// 훅을 쓰지 않는 부품이라 두 쪽에서 모두 그릴 수 있다. 기기 이름·코드·공연명은 글자로만 그린다(HTML로 해석하지 않는다, ASVS 3.2.2).
import Link from 'next/link';
import { ORIGINS } from '@/shared/config/origins';
import type { ApproveMode, DenyReason } from '../model/state';

/** 상태 카드 둘레: 휴대폰 보드 28/20 · 36/20, md 이상은 태블릿 보드 36/32 · 44/32 */
const CARD = 'card state px-5 py-7 md:px-8 md:py-9';
const CARD_TALL = 'card state px-5 py-9 md:px-8 md:py-11';

const DENY_TITLE: Record<Exclude<DenyReason, 'off-hours' | 'proxy'>, string> = {
  'no-assignment': '이 회차에 배정되지 않았습니다',
  'other-partner': '이 기기는 다른 파트너의 기기입니다',
};

export interface ApproveIntroProps {
  /** '하늘 · 현장 책임자'. 모르면 이름 없이 '내 계정' */
  account: string | null;
}

export function ApproveIntro({ account }: ApproveIntroProps) {
  return (
    <p className="t-md">
      스캐너에 뜬 QR을 내 휴대폰 카메라로 찍으면 이 화면이 열립니다. 승인하면 그 스캐너가 {account ? `내 계정(${account})` : '내 계정'}으로 로그인됩니다.
    </p>
  );
}

export interface ApproveLoginCardProps {
  loginHref: string;
}

export function ApproveLoginCard({ loginHref }: ApproveLoginCardProps) {
  return (
    <section className="card state px-5 py-8 md:px-8 md:py-10" aria-labelledby="li-h">
      <span className="state-icon is-primary">
        <i className="ic ic-user" aria-hidden="true" />
      </span>
      <h2 className="t-lg" id="li-h">
        스캐너에 로그인하려면 먼저 이 휴대폰에서 피켓에 로그인하세요
      </h2>
      <Link className="btn btn-primary btn-lg btn-block" href={loginHref} aria-describedby="li-hint">
        로그인
      </Link>
      <p className="hint" id="li-hint">
        로그인 뒤 같은 탭으로 돌아와 이어갑니다
      </p>
    </section>
  );
}

export function ApproveWarning() {
  return (
    <div className="banner banner-warning" role="status">
      <i className="ic ic-alert" aria-hidden="true" />
      <div className="banner-body fw-b">현장 스캐너에 로그인하려고 합니다</div>
    </div>
  );
}

export interface ApproveDeviceCardProps {
  deviceName: string;
  /** 배정 파트너 상호. null이면 '이름을 불러오지 못했습니다'(d5 §5.27 '파트너 이름을 읽지 못함') */
  partnerName: string | null;
}

export function ApproveDeviceCard({ deviceName, partnerName }: ApproveDeviceCardProps) {
  return (
    <section className="card col gap-[14px] p-4 md:p-5 lg:px-6" aria-labelledby="dv-h">
      <div className="row gap-3 md:gap-[14px]">
        <span className="state-icon is-primary size-12 md:size-[52px]">
          <i className="ic ic-device" aria-hidden="true" />
        </span>
        <h2 className="t-lg" id="dv-h">
          이 기기는 {deviceName}입니다
        </h2>
      </div>
      <dl className="kv">
        <dt>배정 파트너</dt>
        <dd>{partnerName !== null ? <span>{partnerName}</span> : <span className="muted">이름을 불러오지 못했습니다</span>}</dd>
      </dl>
    </section>
  );
}

export interface ApproveCodeCardProps {
  code: string;
  /** 낭독 이름(한 글자씩) */
  label: string;
}

/** ③ 확인 코드. 휴대폰은 옅은 면(card-flat), md 이상은 바탕이 옅어져 테두리 카드(card)로 바뀐다(보드) */
export function ApproveCodeCard({ code, label }: ApproveCodeCardProps) {
  return (
    <section
      className="card-flat col items-center gap-2 px-4 py-5 text-center md:border md:border-(--border) md:bg-(--surface) md:px-5 md:py-6 lg:px-6"
      aria-labelledby="cd-h"
    >
      <h2 className="t-sm fw-b muted" id="cd-h">
        확인 코드
      </h2>
      <p className="code-display" role="img" aria-label={label}>
        {code}
      </p>
      <p className="t-sm">스캐너 화면의 코드가 {code}와 같을 때만 승인하세요.</p>
    </section>
  );
}

export interface ApproveDenyCardProps {
  deny: DenyReason;
  /** '지금 로그인한 계정: {이름}'. 모르면 그 줄이 없다 */
  accountName: string | null;
  /** 운영 시간 밖의 '내 권한 유효 시간 …'. 모르면(실제 403 본문에는 배정이 없다) 그 줄이 없다 */
  validText?: string;
}

/** 권한 없음 네 상태: 이유만 보인다(d5 §5.27) */
export function ApproveDenyCard({ deny, accountName, validText }: ApproveDenyCardProps) {
  return (
    <div className={CARD} role="alert">
      <span className="state-icon is-danger">
        <i className="ic ic-ban" aria-hidden="true" />
      </span>
      {deny === 'no-assignment' || deny === 'other-partner' ? <h2 className="t-lg">{DENY_TITLE[deny]}</h2> : null}
      {deny === 'off-hours' ? (
        <div className="col items-center" style={{ gap: 8 }}>
          <h2 className="t-lg">운영 시간 밖입니다</h2>
          <p className="t-sm">권한 유효 시간 안에서만 승인할 수 있습니다.</p>
          {validText ? <p className="t-sm muted">내 권한 유효 시간 {validText}</p> : null}
        </div>
      ) : null}
      {deny === 'proxy' ? <h2 className="t-lg">대리 승인은 현장 책임자만 할 수 있습니다</h2> : null}
      {accountName ? <p className="t-sm muted">지금 로그인한 계정: {accountName}</p> : null}
      <Link className="btn btn-secondary btn-lg btn-block md:w-auto md:min-w-[240px]" href="/staff">
        내 현장 배정 보기
      </Link>
    </div>
  );
}

export interface ApproveResultCardProps {
  mode: ApproveMode;
  /** 승인됨 카드 줄 '동문-03 · LUMEN … · 현장 책임자' */
  approvedText?: string;
  /** 불러오지 못함의 [다시 불러오기](실제 흐름만) */
  onRetry?: () => void;
}

/** 결과·이유 화면: 승인됨 · 거부함 · 코드 만료 · 시도 초과 · 다른 승인이 먼저 처리됨 · 불러오지 못함 */
export function ApproveResultCard({ mode, approvedText, onRetry }: ApproveResultCardProps) {
  switch (mode) {
    case 'approved':
      return (
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
          {approvedText ? <p className="t-sm muted">{approvedText}</p> : null}
        </div>
      );
    case 'rejected':
      return (
        <div className={CARD_TALL} role="alert">
          <span className="state-icon">
            <i className="ic ic-ban" aria-hidden="true" />
          </span>
          <h2 className="t-lg">거부했습니다</h2>
          <p className="t-sm muted">스캐너의 코드는 쓸 수 없게 됩니다.</p>
        </div>
      );
    case 'expired':
      return (
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
      );
    case 'limited':
      return (
        <div className={CARD_TALL} role="alert">
          <span className="state-icon is-warning">
            <i className="ic ic-alert" aria-hidden="true" />
          </span>
          <h2 className="t-lg">승인 시도가 너무 많습니다</h2>
          <p className="t-sm muted">잠시 뒤 다시 시도하세요.</p>
        </div>
      );
    case 'conflict':
      // d5 §5.27 '다른 승인이 먼저 처리됨'(승인 409 device-approval-conflict, ADR-0362 결정 8)
      return (
        <div className={CARD_TALL} role="alert">
          <span className="state-icon is-warning">
            <i className="ic ic-alert" aria-hidden="true" />
          </span>
          <h2 className="t-lg">이 스캐너는 방금 다른 승인으로 처리되었습니다</h2>
          <p className="t-sm muted">스캐너에서 새 QR을 띄워 주세요.</p>
        </div>
      );
    case 'error':
      // d5에 없는 조회 실패(5xx·연결 끊김). 코드는 탭 저장소에 그대로 있어 다시 불러올 수 있다
      return (
        <div className={CARD} role="alert">
          <span className="state-icon is-warning">
            <i className="ic ic-alert" aria-hidden="true" />
          </span>
          <h2 className="t-lg">기기 정보를 불러오지 못했습니다</h2>
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

/** 조회 중: 기기 카드와 확인 코드 뼈대(휴대폰 보드 크기, md 이상은 태블릿 보드 크기) */
export function ApproveLoadingSkeleton() {
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
