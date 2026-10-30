// 이 파일은 손으로 고치지 않는다. docs/design/tokens.json에서 만든다.
// 다시 만들기: pnpm --filter @peaket/ds tokens (차이 검사: tokens:check)

/** 의미 색(라이트·다크). 화면 CSS는 Tailwind 클래스·CSS 변수를 쓰고, 이 값은 Canvas처럼 변수를 못 읽는 곳만 쓴다. */
export const color = {
  light: {
    "surface": "#ffffff",
    "surface-muted": "#f7f8f9",
    "surface-basement": "#f3f4f5",
    "surface-raised": "#ffffff",
    "surface-disabled": "#f3f4f5",
    "border": "#dcdee3",
    "border-input": "#555d6d",
    "border-primary": "#4338CA",
    "text": "#1a1c20",
    "text-muted": "#555d6d",
    "text-disabled": "#d1d3d8",
    "text-on-primary": "#ffffff",
    "primary": "#4338CA",
    "primary-hover": "#332B9E",
    "primary-subtle": "#DFE2FF",
    "link": "#4338CA",
    "success": "#00745f",
    "success-subtle": "#edfaf6",
    "warning": "#755b22",
    "warning-subtle": "#fff7de",
    "danger": "#ca1d13",
    "danger-subtle": "#fdf0f0",
    "info-subtle": "#eff6ff",
    "focus-ring": "#5B5BE8",
    "seat-available": "#079171",
    "seat-held-by-others": "#d1d3d8",
    "seat-mine": "#4338CA",
    "seat-sold": "#555d6d",
    "seat-unavailable": "#eeeff1",
    "seat-wheelchair": "#A3207E",
    "seat-glyph": "#ffffff",
    "slo-ok": "#079171",
    "slo-burning": "#9b7821",
    "slo-breached": "#fa342c",
    "heat-1": "#E0F1FF",
    "heat-2": "#A9D2FE",
    "heat-3": "#6DB0F4",
  },
  dark: {
    "surface": "#16171b",
    "surface-muted": "#1d2025",
    "surface-basement": "#000000",
    "surface-raised": "#1d2025",
    "surface-disabled": "#2b2e35",
    "border": "#393d46",
    "border-input": "#dcdee3",
    "border-primary": "#5B5BE8",
    "text": "#f3f4f5",
    "text-muted": "#dcdee3",
    "text-disabled": "#5b606a",
    "text-on-primary": "#ffffff",
    "primary": "#5B5BE8",
    "primary-hover": "#4338CA",
    "primary-subtle": "#1C1A55",
    "link": "#A9B0FF",
    "success": "#22b27f",
    "success-subtle": "#202926",
    "warning": "#ca901c",
    "warning-subtle": "#302819",
    "danger": "#ff6e60",
    "danger-subtle": "#322323",
    "info-subtle": "#202742",
    "focus-ring": "#A9B0FF",
    "seat-available": "#22b27f",
    "seat-held-by-others": "#5b606a",
    "seat-mine": "#A9B0FF",
    "seat-sold": "#393d46",
    "seat-unavailable": "#1d2025",
    "seat-wheelchair": "#F08FD0",
    "seat-glyph": "#16171b",
    "slo-ok": "#22b27f",
    "slo-burning": "#ca901c",
    "slo-breached": "#ff6e60",
    "heat-1": "#192D41",
    "heat-2": "#1A4268",
    "heat-3": "#1D5B92",
  },
} as const;

export type ColorMode = keyof typeof color;
export type SemanticColor = keyof (typeof color)["light"];

/** 좌석 색(Canvas 좌석맵이 읽는다). 무늬 pattern.seat와 늘 함께 쓴다(d2 §1 다중 감각). */
export const seatColor = {
  light: {
    "available": "#079171",
    "held-by-others": "#d1d3d8",
    "mine": "#4338CA",
    "sold": "#555d6d",
    "unavailable": "#eeeff1",
    "wheelchair": "#A3207E",
    "glyph": "#ffffff",
  },
  dark: {
    "available": "#22b27f",
    "held-by-others": "#5b606a",
    "mine": "#A9B0FF",
    "sold": "#393d46",
    "unavailable": "#1d2025",
    "wheelchair": "#F08FD0",
    "glyph": "#16171b",
  },
} as const;

/** 좌석 무늬(tokens.json pattern.$extensions['com.peaket.pattern']). recently-released는 available 색의 테두리만 그린다. */
export const pattern = {
  seat: {
    "available": "solid",
    "held-by-others": "diagonal-hatch",
    "mine": "solid-with-check",
    "sold": "cross-hatch",
    "unavailable": "dotted",
    "wheelchair": "solid-with-icon",
    "recently-released": "outline",
  },
} as const;

export type SeatState = keyof (typeof pattern)["seat"];
export type SeatPattern = (typeof pattern)["seat"][SeatState];
export const seatColorNames = ["available","held-by-others","mine","sold","unavailable","wheelchair","glyph"] as const;

/** 중단점(px). 휴대폰 배치는 md 미만, 태블릿은 md 이상 lg 미만, 데스크톱은 lg 이상, 고밀도는 xl 이상(d1 §4). */
export const breakpoint = {
  "sm": 480,
  "md": 768,
  "lg": 1280,
  "xl": 1440,
} as const;

/** 모션 길이(ms)와 이징 */
export const motion = {
  duration: {
    "fast": 150,
    "base": 200,
    "slow": 300,
  },
  easing: {
    "enter": "cubic-bezier(0, 0, 0.15, 1)",
    "exit": "cubic-bezier(0.35, 0, 1, 1)",
    "standard": "cubic-bezier(0.35, 0, 0.35, 1)",
    "enter-expressive": "cubic-bezier(0.03, 0.4, 0.1, 1)",
    "exit-expressive": "cubic-bezier(0.35, 0, 0.95, 0.55)",
  },
  seatShakeMs: 300,
  qrRotateMs: 15000,
} as const;

/** 간격(px). 이름은 tokens.json space와 같다(0_5 = 2px) */
export const space = {
  "0_5": 2,
  "1": 4,
  "1_5": 6,
  "2": 8,
  "3": 12,
  "4": 16,
  "5": 20,
  "6": 24,
  "8": 32,
  "10": 40,
  "12": 48,
  "14": 56,
  "16": 64,
  "global-gutter": 16,
  "component-default": 12,
  "nav-to-title": 20,
  "screen-bottom": 56,
  "between-chips": 8,
  "between-text": 6,
} as const;

export const radius = {
  "sm": 4,
  "md": 8,
  "lg": 12,
  "xl": 16,
  "2xl": 24,
  "banner": 20,
  "full": 9999,
} as const;

export const size = {
  "touch-target-min": 24,
  "touch-target-mobile-primary": 44,
} as const;

export const layout = {
  "content-max-width": 1040,
  "content-max-width-wide": 1280,
  "home-content-max-width": 1240,
  "dashboard-max-width": 1040,
  "desktop-gutter": 24,
  "desktop-margin": 32,
} as const;

export const zIndex = {
  "banner": 10,
  "modal": 100,
  "toast": 200,
} as const;

export const fontFamily = {
  "sans": "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Pretendard Variable', Pretendard, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji'",
  "mono": "'JetBrains Mono', ui-monospace, monospace",
} as const;
