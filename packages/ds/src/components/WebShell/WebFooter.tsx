// 소비자 웹 바닥글(CMP-058 footer, d5 §3.1, 캔버스 키트 18절 .wf). 휴대폰은 한 줄로 쌓고, 태블릿은 약관 링크와 언어를 한 줄 양끝에,
// 데스크톱은 1.6:1 두 칸이다(보드 SCR-001·002의 바닥글). 중개자 고지와 구매안전서비스 줄은 POL-037·POL-014 원문 그대로다.
import type { ReactNode } from "react";
import { renderLinkOrAnchor, type RenderLink } from "../../lib/link";

export interface WebFooterHrefs {
  dispute: string;
  terms: string;
  privacy: string;
  help: string;
  escrowCheck: string;
  locales: { ko: string; en: string; ja: string; zh: string };
}

export interface WebFooterProps {
  hrefs: WebFooterHrefs;
  /** 사업자 정보 줄. 없으면 보드의 자리 글을 쓴다 */
  businessInfo?: ReactNode;
  /** 지금 언어(aria-current) */
  locale?: "ko" | "en" | "ja" | "zh";
  renderLink?: RenderLink;
}

/** 바닥글 중개자 고지(공연·상품, POL-037·ADR-0062). 문구를 바꾸지 않는다 */
export const WEB_FOOTER_BROKER_NOTICE =
  "PEAKET은 통신판매중개자로서 공연과 상품 거래의 당사자가 아닙니다. 공연의 개최·변경·취소와 상품의 제공·품질에 따른 책임은 각 판매자에게 있고, 예매·주문 취소와 환불은 PEAKET이 처리합니다. 판매자 정보는 각 공연·상품 상세에 있습니다.";

export function WebFooter({ hrefs, businessInfo, locale = "ko", renderLink }: WebFooterProps) {
  const link = (href: string, children: ReactNode) => renderLinkOrAnchor(renderLink, { href, children });
  const lang = (code: "ko" | "en" | "ja" | "zh", label: string) => (
    // 다국어 주소(/en 등)는 HOT-290~380에서 연다. 언어 바꾸기는 전체 이동이라 그냥 <a>다.
    <a href={hrefs.locales[code]} lang={code} aria-current={locale === code ? "true" : undefined}>
      {label}
    </a>
  );
  return (
    <footer className="wf md:px-6 md:pt-8 lg:px-0 lg:pt-10 lg:pb-12">
      <div className="mx-auto grid w-full max-w-[1280px] gap-3.5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:gap-10 lg:px-8">
        <div className="col" style={{ gap: 14 }}>
          <span className="logo logo-sm">
            <i className="logo-mark" aria-hidden="true" />
            PEAKET
          </span>
          <section aria-label="통신판매중개자 고지">
            <p className="wf-notice">{WEB_FOOTER_BROKER_NOTICE}</p>
          </section>
          <p>
            {businessInfo ??
              "PEAKET(피켓) · 대표 [대표자] · 사업자등록번호 [000-00-00000] · 통신판매업 신고 [제0000-서울○○-0000호] · 주소 [사업장 주소] · 고객센터 [0000-0000]"}
          </p>
          <p>
            구매안전서비스: 굿즈 택배 주문은 토스페이먼츠 결제대금예치를 이용할 수 있습니다 {link(hrefs.escrowCheck, "서비스 가입 사실 확인 ›")}
          </p>
        </div>
        <div className="col gap-3.5 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-3 lg:flex-col lg:items-start lg:justify-start lg:gap-4">
          <nav className="wf-links" aria-label="약관과 정책">
            {link(hrefs.dispute, "분쟁 해결 기준")}
            {link(hrefs.terms, "이용약관")}
            {link(hrefs.privacy, "개인정보 처리방침")}
            {link(hrefs.help, "고객센터")}
          </nav>
          <div className="row wrap" style={{ gap: "4px 12px" }}>
            <i className="ic ic-globe ic-16" aria-hidden="true" />
            <span className="sr-only">언어</span>
            {lang("ko", "한국어")}
            {lang("en", "English")}
            {lang("ja", "日本語")}
            {lang("zh", "中文")}
          </div>
        </div>
      </div>
    </footer>
  );
}
