// 템플릿 10종의 개략도(캔버스 보드 SCR-022 '템플릿 고르기' 카드 그림을 그대로 옮김, viewBox 0 0 160 80).
// 실제 공연장 배치도가 아니라 흔한 모양을 본뜬 그림이다(d5 §6.5 '템플릿의 출처').
import type { ReactNode } from 'react';

export const TEMPLATE_THUMBS: Record<string, ReactNode> = {
  // 실내 아레나 · 엔드 스테이지
  'ARENA-END': (
    <>
      <path d="M136 12A56 56 0 0 1 24 12L34 12A46 46 0 0 0 126 12Z" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: ".8" }} />
      <path d="M124 12A44 44 0 0 1 36 12L46 12A34 34 0 0 0 114 12Z" style={{ fill: "var(--heat-2)" }} />
      <path d="M111.9 23.6L132.6 31.2M106 33.9L122.9 48M97 41.4L108 60.5M85.9 45.5L89.7 67.1M74.1 45.5L70.3 67.1M63 41.4L52 60.5M54 33.9L37.1 48M48.1 23.6L27.4 31.2" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: "1.2" }} />
      <rect x="60" y="16" width="40" height="22" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <path d="M73.3 16V38M86.7 16V38M60 27H100" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: "1.2" }} />
      <rect x="62" y="3" width="36" height="8" rx="1.5" style={{ fill: "var(--inverse)" }} />
    </>
  ),
  // 실내 아레나 · 돌출 무대
  'ARENA-THRUST': (
    <>
      <path d="M136 12A56 56 0 0 1 24 12L34 12A46 46 0 0 0 126 12Z" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: ".8" }} />
      <path d="M124 12A44 44 0 0 1 36 12L46 12A34 34 0 0 0 114 12Z" style={{ fill: "var(--heat-2)" }} />
      <path d="M111.9 23.6L132.6 31.2M106 33.9L122.9 48M97 41.4L108 60.5M85.9 45.5L89.7 67.1M74.1 45.5L70.3 67.1M63 41.4L52 60.5M54 33.9L37.1 48M48.1 23.6L27.4 31.2" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: "1.2" }} />
      <rect x="60" y="16" width="16" height="21" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <rect x="84" y="16" width="16" height="21" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <path d="M60 26.5H76M84 26.5H100" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: "1.2" }} />
      <rect x="62" y="3" width="36" height="8" rx="1.5" style={{ fill: "var(--inverse)" }} />
      <rect x="77" y="9" width="6" height="25" rx="1" style={{ fill: "var(--inverse)" }} />
    </>
  ),
  // 실내 아레나 · 센터 무대
  'ARENA-CENTER': (
    <>
      <path d="M5 40a75 38 0 1 0 150 0a75 38 0 1 0 -150 0ZM12 40a68 33.5 0 1 0 136 0a68 33.5 0 1 0 -136 0Z" style={{ fill: "var(--heat-1)", fillRule: "evenodd", stroke: "var(--border)", strokeWidth: ".8" }} />
      <path d="M14 40a66 32 0 1 0 132 0a66 32 0 1 0 -132 0ZM22 40a58 27 0 1 0 116 0a58 27 0 1 0 -116 0Z" style={{ fill: "var(--heat-2)", fillRule: "evenodd" }} />
      <path d="M138 40L155 40M130.2 53.5L145 59M109 63.4L117.5 72.9M80 67L80 78M51 63.4L42.5 72.9M29.8 53.5L15 59M22 40L5 40M29.8 26.5L15 21M51 16.6L42.5 7.1M80 13L80 2M109 16.6L117.5 7.1M130.2 26.5L145 21" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: "1.2" }} />
      <rect x="50" y="22" width="60" height="36" rx="2" style={{ fill: "var(--heat-3)" }} />
      <path d="M65 22V58M95 22V58M50 40H71M89 40H110" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: "1.2" }} />
      <rect x="71" y="34" width="18" height="12" rx="1.5" style={{ fill: "var(--inverse)" }} />
    </>
  ),
  // 돔 구장
  'DOME': (
    <>
      <path d="M41 40a39 39 0 1 0 78 0a39 39 0 1 0 -78 0ZM44 40a36 36 0 1 0 72 0a36 36 0 1 0 -72 0Z" style={{ fill: "var(--heat-1)", fillRule: "evenodd", stroke: "var(--border)", strokeWidth: ".6" }} />
      <path d="M45 40a35 35 0 1 0 70 0a35 35 0 1 0 -70 0ZM49 40a31 31 0 1 0 62 0a31 31 0 1 0 -62 0Z" style={{ fill: "var(--heat-1)", fillRule: "evenodd", stroke: "var(--border)", strokeWidth: ".6" }} />
      <path d="M50 40a30 30 0 1 0 60 0a30 30 0 1 0 -60 0ZM55 40a25 25 0 1 0 50 0a25 25 0 1 0 -50 0Z" style={{ fill: "var(--heat-2)", fillRule: "evenodd" }} />
      <path d="M105 40L119 40M101.7 52.5L113.8 59.5M92.5 61.7L99.5 73.8M80 65L80 79M67.5 61.7L60.5 73.8M58.3 52.5L46.2 59.5M55 40L41 40M58.3 27.5L46.2 20.5M67.5 18.3L60.5 6.2M80 15L80 1M92.5 18.3L99.5 6.2M101.7 27.5L113.8 20.5" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: "1.1" }} />
      <circle cx="80" cy="40" r="24" style={{ fill: "var(--surface)" }} />
      <rect x="63" y="34" width="7.5" height="8" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="71.5" y="34" width="7.5" height="8" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="80" y="34" width="7.5" height="8" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="88.5" y="34" width="7.5" height="8" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="63" y="43" width="7.5" height="8" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="71.5" y="43" width="7.5" height="8" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="80" y="43" width="7.5" height="8" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="88.5" y="43" width="7.5" height="8" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="72" y="21" width="16" height="7" rx="1.5" style={{ fill: "var(--inverse)" }} />
    </>
  ),
  // 종합운동장
  'STADIUM': (
    <>
      <rect x="8" y="6" width="144" height="68" rx="34" style={{ fill: "var(--heat-2)" }} />
      <rect x="24" y="16" width="112" height="48" rx="24" style={{ fill: "var(--surface)" }} />
      <path d="M48 6V16M64 6V16M80 6V16M96 6V16M112 6V16M48 64V74M64 64V74M80 64V74M96 64V74M112 64V74" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: "1.2" }} />
      <rect x="46" y="22" width="17" height="11" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="65" y="22" width="17" height="11" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="84" y="22" width="17" height="11" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="103" y="22" width="17" height="11" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="46" y="35" width="17" height="11" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="65" y="35" width="17" height="11" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="84" y="35" width="17" height="11" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="103" y="35" width="17" height="11" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="46" y="48" width="17" height="11" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="65" y="48" width="17" height="11" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="84" y="48" width="17" height="11" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="103" y="48" width="17" height="11" rx="1" style={{ fill: "var(--heat-3)" }} />
      <rect x="30" y="31" width="8" height="18" rx="1.5" style={{ fill: "var(--inverse)" }} />
    </>
  ),
  // 대극장(3층)
  'THEATER-L': (
    <>
      <rect x="44" y="2" width="72" height="8" rx="1.5" style={{ fill: "var(--inverse)" }} />
      <rect x="62" y="11" width="36" height="3.5" rx="1" style={{ fill: "none", stroke: "var(--text-muted)", strokeWidth: ".8", strokeDasharray: "2 1.5" }} />
      <path d="M136.6 33.1A70 70 0 0 1 23.4 33.1L28.2 29.6A64 64 0 0 0 131.8 29.6Z" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: ".6" }} />
      <path d="M126.7 31.2A61 61 0 0 1 33.3 31.2L37.9 27.4A55 55 0 0 0 122.1 27.4Z" style={{ fill: "var(--heat-2)" }} />
      <path d="M114.8 30.6A52 52 0 0 1 45.2 30.6L59.9 14.3A30 30 0 0 0 100.1 14.3Z" style={{ fill: "var(--heat-3)" }} />
      <path d="M87.3 21.1L92.6 42.5M72.7 21.1L67.4 42.5" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: "1.2" }} />
    </>
  ),
  // 중극장(2층)
  'THEATER-M': (
    <>
      <rect x="44" y="2" width="72" height="8" rx="1.5" style={{ fill: "var(--inverse)" }} />
      <rect x="62" y="11" width="36" height="3.5" rx="1" style={{ fill: "none", stroke: "var(--text-muted)", strokeWidth: ".8", strokeDasharray: "2 1.5" }} />
      <path d="M133.6 33.9A68 68 0 0 1 26.4 33.9L33.5 28.3A59 59 0 0 0 126.5 28.3Z" style={{ fill: "var(--heat-2)" }} />
      <path d="M119.6 31.6A56 56 0 0 1 40.4 31.6L58.8 13.2A30 30 0 0 0 101.2 13.2Z" style={{ fill: "var(--heat-3)" }} />
      <path d="M80 22L80 48" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: "1.2" }} />
    </>
  ),
  // 소극장
  'THEATER-S': (
    <>
      <rect x="48" y="6" width="64" height="8" rx="1.5" style={{ fill: "var(--inverse)" }} />
      <path d="M50 22H110L120 70H40Z" style={{ fill: "var(--heat-3)" }} />
      <path d="M47 34H113M44 46H116M42 58H118" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: ".8" }} />
      <path d="M80 22V70" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: "2" }} />
    </>
  ),
  // 콘서트홀(합창석)
  'HALL': (
    <>
      <rect x="22" y="12" width="7" height="60" rx="1.5" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: ".6" }} />
      <rect x="131" y="12" width="7" height="60" rx="1.5" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: ".6" }} />
      <rect x="32" y="16" width="7" height="52" rx="1.5" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: ".6" }} />
      <rect x="121" y="16" width="7" height="52" rx="1.5" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: ".6" }} />
      <rect x="52" y="10" width="56" height="11" rx="1.5" style={{ fill: "var(--heat-2)" }} />
      <rect x="50" y="23" width="60" height="14" rx="1.5" style={{ fill: "var(--inverse)" }} />
      <path d="M44 41H116V66Q80 78 44 66Z" style={{ fill: "var(--heat-3)" }} />
      <path d="M62 41V70M80 41V73M98 41V70" style={{ fill: "none", stroke: "var(--surface-muted)", strokeWidth: "1.2" }} />
    </>
  ),
  // 평면 블록(컨벤션·야외 특설)
  'FLAT': (
    <>
      <rect x="50" y="4" width="60" height="8" rx="1.5" style={{ fill: "var(--inverse)" }} />
      <rect x="22" y="20" width="26" height="14" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <rect x="52" y="20" width="26" height="14" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <rect x="82" y="20" width="26" height="14" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <rect x="112" y="20" width="26" height="14" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <rect x="22" y="38" width="26" height="14" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <rect x="52" y="38" width="26" height="14" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <rect x="82" y="38" width="26" height="14" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <rect x="112" y="38" width="26" height="14" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <rect x="22" y="56" width="26" height="14" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <rect x="52" y="56" width="26" height="14" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <rect x="82" y="56" width="26" height="14" rx="1.5" style={{ fill: "var(--heat-3)" }} />
      <rect x="112" y="56" width="26" height="14" rx="1.5" style={{ fill: "var(--heat-3)" }} />
    </>
  ),
};

/** 템플릿 설정 단계의 큰 미리보기(보드는 실내 아레나 · 엔드 스테이지만 그렸다. viewBox 0 20 640 380) */
export const TEMPLATE_SETUP_PREVIEWS: Record<string, ReactNode> = {
  'ARENA-END': (
    <>
      <path d="M18.2 176.3A320 320 0 0 1 0 73.4L55 72.8A265 265 0 0 0 70 158Z" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M72.7 273.1A320 320 0 0 1 20.5 182.6L71.9 163.2A265 265 0 0 0 115.2 238.2Z" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M157.1 345.4A320 320 0 0 1 77 278.2L118.8 242.5A265 265 0 0 0 185.1 298.1Z" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M261.1 384.5A320 320 0 0 1 162.9 348.8L189.9 300.9A265 265 0 0 0 271.3 330.5Z" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M372.3 385.7A320 320 0 0 1 267.7 385.7L276.7 331.4A265 265 0 0 0 363.3 331.4Z" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M477.1 348.8A320 320 0 0 1 378.9 384.5L368.7 330.5A265 265 0 0 0 450.1 300.9Z" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M563 278.2A320 320 0 0 1 482.9 345.4L454.9 298.1A265 265 0 0 0 521.2 242.5Z" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M619.5 182.6A320 320 0 0 1 567.3 273.1L524.8 238.2A265 265 0 0 0 568.1 163.2Z" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M640 73.4A320 320 0 0 1 621.8 176.3L570 158A265 265 0 0 0 585 72.8Z" style={{ fill: "var(--heat-1)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M79.5 154.7A255 255 0 0 1 65 72.7L120 72.1A200 200 0 0 0 131.4 136.4Z" style={{ fill: "var(--heat-2)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M123 231.9A255 255 0 0 1 81.3 159.7L132.8 140.4A200 200 0 0 0 165.5 196.9Z" style={{ fill: "var(--heat-2)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M190.2 289.5A255 255 0 0 1 126.4 235.9L168.1 200.2A200 200 0 0 0 218.2 242.1Z" style={{ fill: "var(--heat-2)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M273.1 320.6A255 255 0 0 1 194.8 292.2L221.8 244.2A200 200 0 0 0 283.2 266.6Z" style={{ fill: "var(--heat-2)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M361.6 321.6A255 255 0 0 1 278.4 321.6L287.3 267.3A200 200 0 0 0 352.7 267.3Z" style={{ fill: "var(--heat-2)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M445.2 292.2A255 255 0 0 1 366.9 320.6L356.8 266.6A200 200 0 0 0 418.2 244.2Z" style={{ fill: "var(--heat-2)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M513.6 235.9A255 255 0 0 1 449.8 289.5L421.8 242.1A200 200 0 0 0 471.9 200.2Z" style={{ fill: "var(--heat-2)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M558.7 159.7A255 255 0 0 1 517 231.9L474.5 196.9A200 200 0 0 0 507.2 140.4Z" style={{ fill: "var(--heat-2)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <path d="M575 72.7A255 255 0 0 1 560.5 154.7L508.6 136.4A200 200 0 0 0 520 72.1Z" style={{ fill: "var(--heat-2)", stroke: "var(--border)", strokeWidth: "1.5" }} />
      <rect x="230" y="95" width="56" height="56" rx="3" style={{ fill: "var(--heat-3)" }} />
      <rect x="292" y="95" width="56" height="56" rx="3" style={{ fill: "var(--heat-3)" }} />
      <rect x="354" y="95" width="56" height="56" rx="3" style={{ fill: "var(--heat-3)" }} />
      <rect x="230" y="157" width="56" height="56" rx="3" style={{ fill: "var(--heat-3)" }} />
      <rect x="292" y="157" width="56" height="56" rx="3" style={{ fill: "var(--heat-3)" }} />
      <rect x="354" y="157" width="56" height="56" rx="3" style={{ fill: "var(--heat-3)" }} />
      <rect x="250" y="25" width="140" height="45" rx="6" style={{ fill: "var(--inverse)" }} />
      <text x="320" y="54" textAnchor="middle" style={{ fill: "var(--on-inverse)", fontSize: "18px", fontWeight: "700", letterSpacing: ".2em" }}>무대</text>
      <text x="258" y="129" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "16px", fontWeight: "700" }}>F1</text>
      <text x="320" y="129" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "16px", fontWeight: "700" }}>F2</text>
      <text x="382" y="129" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "16px", fontWeight: "700" }}>F3</text>
      <text x="258" y="191" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "16px", fontWeight: "700" }}>F4</text>
      <text x="320" y="191" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "16px", fontWeight: "700" }}>F5</text>
      <text x="382" y="191" textAnchor="middle" style={{ fill: "var(--text)", fontSize: "16px", fontWeight: "700" }}>F6</text>
      <text x="96" y="115" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>201</text>
      <text x="123" y="189" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>202</text>
      <text x="174" y="250" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>203</text>
      <text x="242" y="289" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>204</text>
      <text x="320" y="303" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>205</text>
      <text x="398" y="289" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>206</text>
      <text x="466" y="250" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>207</text>
      <text x="517" y="189" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>208</text>
      <text x="544" y="115" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>209</text>
      <text x="32" y="126" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>301</text>
      <text x="67" y="221" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>302</text>
      <text x="132" y="299" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>303</text>
      <text x="220" y="350" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>304</text>
      <text x="320" y="368" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>305</text>
      <text x="420" y="350" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>306</text>
      <text x="508" y="299" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>307</text>
      <text x="573" y="221" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>308</text>
      <text x="608" y="126" textAnchor="middle" style={{ fill: "var(--heat-ink)", fontSize: "15px", fontWeight: "700" }}>309</text>
    </>
  ),
};
