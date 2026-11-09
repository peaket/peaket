// CMP-055 AccountLinkPrompt(계정 연결 제안). 정본: d2 CMP-055, d5 §5.21, d3 SCR-039, 캔버스 보드 SCR-039-m·t·d.
// 보드 마크업: .col(gap 24) 안에 머리(.state-icon.is-primary 40px ic-link · h1.t-lg · 제안 문단 p.t-md)
//   → dl.kv.card-flat(이미 가입한 계정: 로그인 수단·가린 이메일) → (error) .banner.banner-danger role=alert
//   → 안내 한 줄 p.t-sm.fw-b + 제공자 가이드 버튼(btn-kakao btn-lg btn-block) + [새 계정 만들기](btn-secondary)
//   → 남은 시간 줄(p.row.t-sm.muted: 보이는 9:41은 aria-hidden, 분 단위 낭독은 sr-only aria-live=polite) · ( 창 닫기 › ).
//   expired: .state role=alert(.state-icon.is-warning ic-clock · 제목 · ( 로그인 › )).
// - 상태: proposed · verifying(누른 버튼만 스피너, 나머지 비활성) · error(다른 계정으로 인증) · expired(10분·닫기·3회 실패).
// - 기존 계정은 제공자 종류만 알리고, 닉네임·전체 이메일은 가린 값을 받는다. 서버 컴포넌트에서도 쓴다(함수 props 없음).
// - 바깥 카드(태블릿·데스크톱의 .card)는 부르는 화면이 감싼다.
import { Fragment, type ReactNode } from "react";
import { cx } from "../../lib/cx";
import { renderLinkOrAnchor, type RenderLink } from "../../lib/link";
import { Icon } from "../../icons";

export type AccountLinkStatus = "proposed" | "verifying" | "error" | "expired";
export type AccountLinkProvider = "kakao" | "naver" | "google";

export interface AccountLinkPromptProps {
  status: AccountLinkStatus;
  /** 제목(예: '계정 연결') */
  title: ReactNode;
  /** 제안 문단(제목 바로 아래 첫 문단, d3 SCR-039) */
  message: ReactNode;
  /** 이미 가입한 계정 요약 dl의 이름(aria-label) */
  accountLabel: string;
  /** 이미 가입한 계정 요약(로그인 수단·가린 이메일). mono면 고정폭 */
  account: readonly { term: ReactNode; value: ReactNode; mono?: boolean }[];
  /** 버튼 앞 안내 한 줄(제공자 이름을 밝힌다, ADR-0059 결정 6) */
  instruction: ReactNode;
  /** 처음 가입한 제공자(가이드 버튼 모양) */
  provider: AccountLinkProvider;
  /** 가이드 버튼 문구(예: '카카오 로그인') */
  providerLabel: string;
  /** 다른 계정으로 인증했을 때 글(error) */
  errorText?: ReactNode;
  /** [새 계정 만들기] 글과 주소 */
  newAccount: { label: string; href: string };
  /** 제안 남은 초(보이는 m:ss, 낭독은 분 단위) */
  remaining: number;
  /** 남은 시간 앞말(기본 '남은 시간') */
  remainingLabel?: string;
  /** ( 창 닫기 › ) 글과 주소 */
  close: { label: string; href: string };
  /** expired 제목과 ( 로그인 › ) 링크 */
  expired: { title: ReactNode; actionLabel: string; actionHref: string };
  /** 제목 수준(화면의 h1이면 1) */
  headingLevel?: 1 | 2;
  renderLink?: RenderLink;
  className?: string;
  /** 실제 화면: [기존 제공자 로그인]을 누르면(없으면 버튼만, 퍼블리싱) */
  onProvider?: () => void;
  /** 실제 화면: [새 계정 만들기]를 링크 대신 버튼으로(POST를 부르는 쪽이 한다) */
  onNewAccount?: () => void;
}

function clock(total: number): string {
  const s = Math.max(0, Math.floor(total));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function AccountLinkPrompt({
  status,
  title,
  message,
  accountLabel,
  account,
  instruction,
  provider,
  providerLabel,
  errorText,
  newAccount,
  remaining,
  remainingLabel = "남은 시간",
  close,
  expired,
  headingLevel = 1,
  renderLink,
  className,
  onProvider,
  onNewAccount,
}: AccountLinkPromptProps) {
  const H = headingLevel === 1 ? "h1" : "h2";

  if (status === "expired") {
    return (
      <div className={cx("state", className)} role="alert" style={{ margin: "auto", padding: "40px 16px" }}>
        <span className="state-icon is-warning">
          <Icon name="clock" />
        </span>
        <H className="t-lg">{expired.title}</H>
        {renderLinkOrAnchor(renderLink, {
          href: expired.actionHref,
          className: "link-more",
          children: (
            <>
              {expired.actionLabel}
              <Icon name="chevron-right" />
            </>
          ),
        })}
      </div>
    );
  }

  const busy = status === "verifying";
  const minutes = Math.max(0, Math.floor(remaining / 60));

  return (
    <div className={cx("col", className)} style={{ gap: 24 }}>
      <div className="col" style={{ gap: 12 }}>
        <span className="state-icon is-primary" style={{ width: 40, height: 40 }}>
          <Icon name="link" />
        </span>
        <H className="t-lg">{title}</H>
        <p className="t-md">{message}</p>
      </div>

      <dl className="kv card-flat" aria-label={accountLabel} style={{ padding: "14px 16px" }}>
        {account.map((row, i) => (
          <Fragment key={i}>
            <dt>{row.term}</dt>
            <dd className={row.mono ? "mono" : undefined}>{row.value}</dd>
          </Fragment>
        ))}
      </dl>

      {status === "error" && errorText ? (
        <div className="banner banner-danger" role="alert">
          <Icon name="alert-circle" />
          <div className="banner-body">{errorText}</div>
        </div>
      ) : null}

      <div className="col" style={{ gap: 10 }}>
        <p className="t-sm fw-b">{instruction}</p>
        <button className={`btn btn-${provider} btn-lg btn-block`} type="button" aria-busy={busy ? true : undefined} onClick={busy ? undefined : onProvider}>
          {busy ? <span className="spinner" aria-hidden="true" /> : <i className={`prov prov-${provider}`} aria-hidden="true" />}
          {providerLabel}
        </button>
        {busy ? (
          <button className="btn btn-secondary btn-lg btn-block" type="button" disabled>
            {newAccount.label}
          </button>
        ) : onNewAccount ? (
          <button className="btn btn-secondary btn-lg btn-block" type="button" onClick={onNewAccount}>
            {newAccount.label}
          </button>
        ) : (
          renderLinkOrAnchor(renderLink, { href: newAccount.href, className: "btn btn-secondary btn-lg btn-block", children: newAccount.label })
        )}
      </div>

      <div className="row between" style={{ gap: 12 }}>
        <p className="row t-sm muted" style={{ gap: 6 }}>
          <Icon name="clock" size={16} />
          <span aria-hidden="true">
            {remainingLabel} <span className="num fw-b">{clock(remaining)}</span>
          </span>
          <span className="sr-only" aria-live="polite">
            {remainingLabel} {minutes}분
          </span>
        </p>
        {busy ? (
          <span className="t-sm fw-b tx-disabled" aria-disabled="true">
            {close.label}
          </span>
        ) : (
          renderLinkOrAnchor(renderLink, {
            href: close.href,
            className: "link-more",
            children: (
              <>
                {close.label}
                <Icon name="chevron-right" />
              </>
            ),
          })
        )}
      </div>
    </div>
  );
}
