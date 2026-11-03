// 디자인 토큰 빌드(docs/design/d2 §1, openspec/changes/add-screen-publishing/design.md 결정 4)
//
// docs/design/tokens.json(정본) 하나를 Style Dictionary 5로 읽어 src/gen/에 다섯 파일을 만든다.
//   tokens.css      CSS 변수. 피켓 변수(--peaket-*)와, SEED 변수(--seed-*)를 덮어쓰는 값을 함께 둔다.
//                   라이트는 :root, 다크는 SEED가 쓰는 다크 선택자(아래 DARK_SELECTOR)에 둔다.
//   theme.css       Tailwind 4 @theme. 기본 중단점·색·글자 크기 등을 지우고 토큰만 남긴다.
//   tokens.ts       Canvas처럼 CSS 변수를 못 읽는 곳이 쓰는 TS 상수(좌석 색·무늬, 중단점 등).
//   kit-tokens.css  캔버스 키트(src/styles/kit.css)의 변수 블록 .pk{…}·.pk.dark{…}. 아래 KIT_VARS 대응표로 만든다.
//   queue-room-tokens.css  대기실 경량 CSS(src/styles/queue-room.css)용 같은 블록(좌석·SLO·heat 변수를 뺀 것).
//
// 쓰는 법
//   node scripts/build-tokens.mjs           파일을 만든다
//   node scripts/build-tokens.mjs --check   메모리에서 다시 만들어 디스크 파일과 다르면 종료 코드 1

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import StyleDictionary from "style-dictionary";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "../..");
const tokensPath = resolve(repoRoot, "docs/design/tokens.json");
const outDir = resolve(pkgRoot, "src/gen");
const checkMode = process.argv.includes("--check");

// SEED 3.0.3 base.layered.css가 쓰는 색 모드 선택자를 그대로 옮긴다(@seed-design/css/base.layered.css에서 확인).
// SEED는 system 모드에서 prefers-color-scheme을 CSS로 직접 보지 않고, 색 모드 스크립트(@seed-design/css/theming)가
// html에 data-seed-user-color-scheme을 달아 고른다. 그래서 피켓도 같은 선택자를 써서 SEED와 함께 바뀌게 한다.
const LIGHT_SELECTOR = [
  ":root",
  ':root[data-seed-color-mode="system"][data-seed-user-color-scheme="light"]',
  ':root[data-seed-color-mode="light-only"]',
  ':root [data-seed-color-mode="light-only"]',
].join(",\n  ");
// 퍼블리싱 화면은 키트처럼 맨 바깥(body)의 `.pk.dark`로 다크를 켜므로(SEED 색 모드 스크립트는 아직 싣지 않는다) 그 선택자도 둔다.
const DARK_SELECTOR = [
  ".pk.dark",
  ':root[data-seed-color-mode="system"][data-seed-user-color-scheme="dark"]',
  ':root[data-seed-color-mode="dark-only"]',
  ':root [data-seed-color-mode="dark-only"]',
].join(",\n  ");

// tokens.json에 짝이 없는 SEED 브랜드 역할. SEED 부품이 쓰므로 당근 색이 새지 않게 가까운 피켓 의미 토큰 값으로 덮는다.
// (recipes/*.layered.css에서 쓰는 곳을 확인했다. carrot-200은 브랜드 역할 대신 팔레트를 바로 쓰는 곳이 있어 함께 덮는다.)
const SEED_EXTRA_OVERRIDES = {
  "--seed-color-bg-brand-weak-pressed": "primary-subtle",
  "--seed-color-fg-brand-contrast": "link",
  "--seed-color-stroke-brand-weak": "primary-subtle",
  "--seed-color-palette-carrot-200": "primary-subtle",
};

// 캔버스 키트 변수 → tokens.json 경로 대응표(kit-tokens.css를 만든다).
// - light는 .pk, dark는 .pk.dark에 쓴다. dark가 null이면 다크 블록에 쓰지 않는다(라이트 값을 물려받는다. 캔버스 키트와 같다).
// - 경로 대신 { raw }를 쓰면 tokens.json에 없는 키트 전용 값이다. 지금은 없다(2026-10-31 --scrim·--heat-ink를 토큰으로 옮겼다, 소유자 '추천대로 진행').
// - 의미 토큰이 없어 원시 팔레트 경로에 이은 것(fill-weak 등)은 note에 적었다. 값은 캔버스 키트와 같다.
// 2026-10-31 대조: 의미 토큰과 이은 변수는 라이트·다크 모두 캔버스 키트 값과 같았다.
const KIT_VARS = [
  ["--surface", "color.semantic.light.surface", "color.semantic.dark.surface"],
  ["--surface-muted", "color.semantic.light.surface-muted", "color.semantic.dark.surface-muted"],
  ["--surface-basement", "color.semantic.light.surface-basement", "color.semantic.dark.surface-basement"],
  ["--surface-raised", "color.semantic.light.surface-raised", "color.semantic.dark.surface-raised"],
  ["--surface-disabled", "color.semantic.light.surface-disabled", "color.semantic.dark.surface-disabled"],
  ["--fill-weak", "color.primitive.gray.200", "color.primitive-dark.gray.300", "의미 토큰 없음(원시 팔레트)"],
  ["--fill-weak-strong", "color.primitive.gray.300", "color.primitive-dark.gray.400", "의미 토큰 없음(원시 팔레트)"],
  ["--border", "color.semantic.light.border", "color.semantic.dark.border"],
  ["--border-input", "color.semantic.light.border-input", "color.semantic.dark.border-input"],
  ["--border-primary", "color.semantic.light.border-primary", "color.semantic.dark.border-primary"],
  ["--text", "color.semantic.light.text", "color.semantic.dark.text"],
  ["--text-muted", "color.semantic.light.text-muted", "color.semantic.dark.text-muted"],
  ["--text-disabled", "color.semantic.light.text-disabled", "color.semantic.dark.text-disabled"],
  ["--text-on-primary", "color.semantic.light.text-on-primary", "color.semantic.dark.text-on-primary"],
  ["--primary", "color.semantic.light.primary", "color.semantic.dark.primary"],
  ["--primary-hover", "color.semantic.light.primary-hover", "color.semantic.dark.primary-hover"],
  ["--primary-subtle", "color.semantic.light.primary-subtle", "color.semantic.dark.primary-subtle"],
  ["--link", "color.semantic.light.link", "color.semantic.dark.link"],
  ["--success", "color.semantic.light.success", "color.semantic.dark.success"],
  ["--success-subtle", "color.semantic.light.success-subtle", "color.semantic.dark.success-subtle"],
  ["--warning", "color.semantic.light.warning", "color.semantic.dark.warning"],
  ["--warning-subtle", "color.semantic.light.warning-subtle", "color.semantic.dark.warning-subtle"],
  ["--danger", "color.semantic.light.danger", "color.semantic.dark.danger"],
  ["--danger-subtle", "color.semantic.light.danger-subtle", "color.semantic.dark.danger-subtle"],
  ["--on-danger", "color.primitive.gray.0", "color.primitive-dark.gray.100", "의미 토큰 없음(원시 팔레트)"],
  ["--info-subtle", "color.semantic.light.info-subtle", "color.semantic.dark.info-subtle"],
  ["--focus-ring", "color.semantic.light.focus-ring", "color.semantic.dark.focus-ring"],
  ["--seat-available", "color.semantic.light.seat.available", "color.semantic.dark.seat.available"],
  ["--seat-held", "color.semantic.light.seat.held-by-others", "color.semantic.dark.seat.held-by-others"],
  ["--seat-mine", "color.semantic.light.seat.mine", "color.semantic.dark.seat.mine"],
  ["--seat-sold", "color.semantic.light.seat.sold", "color.semantic.dark.seat.sold"],
  ["--seat-unavailable", "color.semantic.light.seat.unavailable", "color.semantic.dark.seat.unavailable"],
  ["--seat-wheelchair", "color.semantic.light.seat.wheelchair", "color.semantic.dark.seat.wheelchair"],
  ["--seat-glyph", "color.semantic.light.seat.glyph", "color.semantic.dark.seat.glyph"],
  ["--slo-ok", "color.semantic.light.slo.ok", "color.semantic.dark.slo.ok"],
  ["--slo-burning", "color.semantic.light.slo.burning", "color.semantic.dark.slo.burning"],
  ["--slo-breached", "color.semantic.light.slo.breached", "color.semantic.dark.slo.breached"],
  ["--inverse", "color.primitive.gray.900", "color.primitive-dark.gray.900", "의미 토큰 없음(원시 팔레트)"],
  ["--on-inverse", "color.primitive.gray.0", "color.primitive-dark.gray.100", "의미 토큰 없음(원시 팔레트)"],
  ["--switch-off", "color.primitive.gray.700", null, "의미 토큰 없음(원시 팔레트)"],
  ["--heat-1", "color.semantic.light.heat.1", "color.semantic.dark.heat.1"],
  ["--heat-2", "color.semantic.light.heat.2", "color.semantic.dark.heat.2"],
  ["--heat-3", "color.semantic.light.heat.3", "color.semantic.dark.heat.3"],
  ["--heat-ink", "color.semantic.light.heat.ink", "color.semantic.dark.heat.ink"],
  ["--shadow-sm", "shadow.light.sm", "shadow.dark.sm"],
  ["--shadow-md", "shadow.light.md", "shadow.dark.md"],
  ["--shadow-lg", "shadow.light.lg", "shadow.dark.lg"],
  ["--scrim", "color.semantic.light.scrim", "color.semantic.dark.scrim"],
  ["--r-sm", "radius.sm", null],
  ["--r-md", "radius.md", null],
  ["--r-lg", "radius.lg", null],
  ["--r-xl", "radius.xl", null],
  ["--r-2xl", "radius.2xl", null],
  // 글꼴은 정본 순서 그대로다. 캔버스가 Pretendard 대신 싣던 'Noto Sans KR'은 넣지 않는다(앱이 Pretendard를 자체 호스팅한다, d2 §1).
  ["--font", "typography.font-family.sans", null],
  ["--mono", "typography.font-family.mono", null],
];

const HEADER_LINES = [
  "이 파일은 손으로 고치지 않는다. docs/design/tokens.json에서 만든다.",
  "다시 만들기: pnpm --filter @peaket/ds tokens (차이 검사: tokens:check)",
];
const cssHeader = `/*\n${HEADER_LINES.map((l) => ` * ${l}`).join("\n")}\n */\n`;
const tsHeader = `${HEADER_LINES.map((l) => `// ${l}`).join("\n")}\n`;

const raw = JSON.parse(readFileSync(tokensPath, "utf8"));

const sd = new StyleDictionary({
  tokens: raw,
  usesDtcg: true,
  log: { verbosity: "silent", warnings: "disabled" },
  platforms: {
    peaket: {
      transforms: ["shadow/css/shorthand", "cubicBezier/css", "fontFamily/css"],
    },
  },
});

const dictionary = await sd.getPlatformTokens("peaket");
const all = dictionary.allTokens;

/** 경로로 토큰 하나를 찾는다. 없으면 빌드를 멈춘다(정본이 바뀐 것을 놓치지 않게). */
function token(...path) {
  const key = path.join(".");
  const found = all.find((t) => t.path.join(".") === key);
  if (!found) throw new Error(`tokens.json에 ${key}가 없다`);
  return found;
}
/** 경로 앞부분이 같은 토큰을 tokens.json 순서대로 모은다. */
function group(...prefix) {
  const key = prefix.join(".");
  return all.filter((t) => t.path.slice(0, prefix.length).join(".") === key);
}
const v = (t) => String(t.$value);
/** 토큰 이름 조각을 CSS 이름으로. 밑줄 소수(1_5)는 그대로 둔다. */
const name = (parts) => parts.join("-");

// ---------------------------------------------------------------- 의미 색
const modes = ["light", "dark"];
/** mode별 [이름, 값, SEED 대응] 목록. 이름은 semantic.<mode> 아래 경로(seat.available → seat-available) */
const semantic = Object.fromEntries(
  modes.map((mode) => [
    mode,
    group("color", "semantic", mode).map((t) => {
      const rest = t.path.slice(3);
      return { name: name(rest), value: v(t), seed: t.$extensions?.seed, top: rest.length === 1 };
    }),
  ]),
);
for (const mode of modes) {
  const names = semantic[mode].map((s) => s.name).join(",");
  const otherNames = semantic[modes.find((m) => m !== mode)].map((s) => s.name).join(",");
  if (names !== otherNames) throw new Error("color.semantic.light와 dark의 키가 다르다(d2 §1)");
}

/** 위쪽 의미 색(seat·slo·heat 묶음 밖)만 SEED 역할 변수를 덮는다. 팔레트 대응은 덮지 않는다. */
function seedOverrides(mode) {
  const out = [];
  const byName = Object.fromEntries(semantic[mode].map((s) => [s.name, s.value]));
  for (const s of semantic[mode]) {
    if (!s.top || typeof s.seed !== "string") continue;
    if (!s.seed.startsWith("$color.") || s.seed.startsWith("$color.palette.")) continue;
    out.push([`--seed-color-${s.seed.slice("$color.".length).replaceAll(".", "-")}`, s.value]);
  }
  for (const [seedVar, peaketName] of Object.entries(SEED_EXTRA_OVERRIDES)) {
    if (!(peaketName in byName)) throw new Error(`SEED 덮어쓰기 대상 ${peaketName}이 없다`);
    out.push([seedVar, byName[peaketName]]);
  }
  return out;
}

const shadow = Object.fromEntries(
  modes.map((mode) => [mode, group("shadow", mode).map((t) => ({ name: t.path[2], value: v(t) }))]),
);

// ---------------------------------------------------------------- 그 밖의 토큰
const fontFamily = group("typography", "font-family").map((t) => ({ name: t.path[2], value: v(t) }));
const fontSize = group("typography", "size").map((t) => ({ name: t.path[2], value: v(t) }));
const lineHeight = Object.fromEntries(
  group("typography", "line-height").map((t) => [t.path[2], v(t)]),
);
const fontWeight = group("typography", "weight").map((t) => ({ name: t.path[2], value: v(t) }));
const spaceScale = group("space")
  .filter((t) => t.path.length === 2)
  .map((t) => ({ name: t.path[1], value: v(t) }))
  .sort((a, b) => Number.parseFloat(a.value) - Number.parseFloat(b.value));
const spaceSemantic = group("space", "semantic").map((t) => ({ name: t.path[2], value: v(t) }));
const sizes = group("size").map((t) => ({ name: t.path[1], value: v(t) }));
const radius = group("radius").map((t) => ({ name: t.path[1], value: v(t) }));
const durations = group("motion", "duration").map((t) => ({ name: t.path[2], value: v(t) }));
const easings = group("motion", "easing").map((t) => ({ name: t.path[2], value: v(t) }));
const seatShake = v(token("motion", "seat-shake"));
const qrRotate = v(token("motion", "qr-rotate"));
const breakpoints = group("breakpoint").map((t) => ({ name: t.path[1], value: v(t) }));
const layout = group("layout").map((t) => ({ name: t.path[1], value: v(t) }));
const zIndex = group("z-index").map((t) => ({ name: t.path[1], value: v(t) }));

// 좌석 무늬는 토큰이 아니라 확장 칸에 있다(d2 §1 '단일 소스 관리 체계')
const seatPattern = raw.pattern?.$extensions?.["com.peaket.pattern"]?.seat;
if (!seatPattern) throw new Error("tokens.json pattern.$extensions['com.peaket.pattern'].seat가 없다");

// 간격 숫자 이름이 4px 배수인지 본다. Tailwind의 --spacing(4px) 배수 이름(p-4 = space.4)과 맞추기 위해서다.
const spacingUnit = v(token("space", "1"));
for (const s of spaceScale) {
  const n = Number(s.name.replace("_", "."));
  if (`${n * Number.parseFloat(spacingUnit)}px` !== s.value) {
    throw new Error(`space.${s.name}(${s.value})가 ${spacingUnit} 배수 이름과 맞지 않는다`);
  }
}

// ---------------------------------------------------------------- tokens.css
function block(selector, lines) {
  return `  ${selector} {\n${lines.map(([k, val]) => `    ${k}: ${val};`).join("\n")}\n  }\n`;
}
function colorLines(mode) {
  return [
    ...semantic[mode].map((s) => [`--peaket-color-${s.name}`, s.value]),
    ...shadow[mode].map((s) => [`--peaket-shadow-${s.name}`, s.value]),
    ...seedOverrides(mode),
  ];
}
const staticLines = [
  ...fontFamily.map((f) => [`--peaket-font-family-${f.name}`, f.value]),
  ...fontSize.map((f) => [`--peaket-font-size-${f.name}`, f.value]),
  ...fontSize.map((f) => [`--peaket-line-height-${f.name}`, lineHeight[f.name]]),
  ...fontWeight.map((f) => [`--peaket-font-weight-${f.name}`, f.value]),
  ...spaceScale.map((s) => [`--peaket-space-${s.name}`, s.value]),
  ...spaceSemantic.map((s) => [`--peaket-space-${s.name}`, s.value]),
  ...sizes.map((s) => [`--peaket-size-${s.name}`, s.value]),
  ...radius.map((r) => [`--peaket-radius-${r.name}`, r.value]),
  ...durations.map((d) => [`--peaket-duration-${d.name}`, d.value]),
  ...easings.map((e) => [`--peaket-easing-${e.name}`, e.value]),
  ["--peaket-motion-seat-shake", seatShake],
  ["--peaket-motion-qr-rotate", qrRotate],
  ...breakpoints.map((b) => [`--peaket-breakpoint-${b.name}`, b.value]),
  ...layout.map((l) => [`--peaket-layout-${l.name}`, l.value]),
  ...zIndex.map((z) => [`--peaket-z-${z.name}`, z.value]),
];

const tokensCss =
  cssHeader +
  `/*
 * 피켓 CSS는 모두 components 층에 둔다(d2 §1 'CSS 층 순서'). SEED base(seed-base 층)보다 뒤 층이라
 * 같은 이름의 --seed-* 변수를 덮어쓴다. 다크 선택자는 SEED와 같다(색 모드 스크립트가 html에 단 속성).
 */
@layer components {
${block(":root", staticLines)}
${block(LIGHT_SELECTOR, colorLines("light"))}
${block(DARK_SELECTOR, colorLines("dark"))}}
`;

// ---------------------------------------------------------------- theme.css
const themeStatic = [
  ["--breakpoint-*", "initial"],
  ...breakpoints.map((b) => [`--breakpoint-${b.name}`, b.value]),
  ["--color-*", "initial"],
  ["--text-*", "initial"],
  ["--font-*", "initial"],
  ["--radius-*", "initial"],
  ["--shadow-*", "initial"],
  ["--inset-shadow-*", "initial"],
  ["--drop-shadow-*", "initial"],
  ["--ease-*", "initial"],
  ["--spacing", spacingUnit],
  ...spaceSemantic.map((s) => [`--spacing-${s.name}`, s.value]),
  ...sizes.map((s) => [`--spacing-${s.name}`, s.value]),
  ...fontFamily.map((f) => [`--font-${f.name}`, f.value]),
  ...fontSize.flatMap((f) => [
    [`--text-${f.name}`, f.value],
    [`--text-${f.name}--line-height`, lineHeight[f.name]],
  ]),
  ...fontWeight.map((f) => [`--font-weight-${f.name}`, f.value]),
  ...radius.map((r) => [`--radius-${r.name}`, r.value]),
  ...easings.map((e) => [`--ease-${e.name}`, e.value]),
  ...durations.map((d) => [`--transition-duration-${d.name}`, d.value]),
  ["--default-transition-duration", v(token("motion", "duration", "fast"))],
  ["--default-transition-timing-function", v(token("motion", "easing", "standard"))],
  ...zIndex.map((z) => [`--z-index-${z.name}`, z.value]),
  // 최대 너비는 max-w-content처럼, 바깥 여백·거터는 px-desktop-margin처럼 쓴다
  ...layout
    .filter((l) => l.name.includes("max-width"))
    .map((l) => [`--container-${l.name.replace("-max-width", "")}`, l.value]),
  ...layout
    .filter((l) => !l.name.includes("max-width"))
    .map((l) => [`--spacing-${l.name}`, l.value]),
];
const themeInline = [
  ...semantic.light.map((s) => [`--color-${s.name}`, `var(--peaket-color-${s.name})`]),
  ...shadow.light.map((s) => [`--shadow-${s.name}`, `var(--peaket-shadow-${s.name})`]),
];
const themeCss =
  cssHeader +
  `/*
 * Tailwind 4 테마. 앱 CSS가 tailwindcss 다음에 @peaket/ds/styles.css를 실으면 함께 들어온다.
 * 색·그림자는 라이트·다크가 바뀌므로 @theme inline으로 피켓 변수를 그 자리에서 읽는다.
 * 원시 팔레트(color.primitive*)는 내지 않는다. 화면 코드는 의미 색만 쓴다(d2 §1).
 */
@theme {
${themeStatic.map(([k, val]) => `  ${k}: ${val};`).join("\n")}
}

@theme inline {
${themeInline.map(([k, val]) => `  ${k}: ${val};`).join("\n")}
}
`;

// ---------------------------------------------------------------- tokens.ts
const px = (s) => Number.parseFloat(s);
const ms = (s) => Number.parseFloat(s);
const objLiteral = (entries, indent = "  ") =>
  `{\n${entries.map(([k, val]) => `${indent}  ${JSON.stringify(k)}: ${val},`).join("\n")}\n${indent}}`;
const colorObj = (mode) => objLiteral(semantic[mode].map((s) => [s.name, JSON.stringify(s.value)]));
const seatNames = semantic.light.filter((s) => s.name.startsWith("seat-")).map((s) => s.name.slice(5));
const seatColorObj = (mode) =>
  objLiteral(
    semantic[mode]
      .filter((s) => s.name.startsWith("seat-"))
      .map((s) => [s.name.slice(5), JSON.stringify(s.value)]),
    "  ",
  );

const tokensTs =
  tsHeader +
  `
/** 의미 색(라이트·다크). 화면 CSS는 Tailwind 클래스·CSS 변수를 쓰고, 이 값은 Canvas처럼 변수를 못 읽는 곳만 쓴다. */
export const color = {
  light: ${colorObj("light")},
  dark: ${colorObj("dark")},
} as const;

export type ColorMode = keyof typeof color;
export type SemanticColor = keyof (typeof color)["light"];

/** 좌석 색(Canvas 좌석맵이 읽는다). 무늬 pattern.seat와 늘 함께 쓴다(d2 §1 다중 감각). */
export const seatColor = {
  light: ${seatColorObj("light")},
  dark: ${seatColorObj("dark")},
} as const;

/** 좌석 무늬(tokens.json pattern.$extensions['com.peaket.pattern']). recently-released는 available 색의 테두리만 그린다. */
export const pattern = {
  seat: ${objLiteral(Object.entries(seatPattern).map(([k, val]) => [k, JSON.stringify(val)]), "  ")},
} as const;

export type SeatState = keyof (typeof pattern)["seat"];
export type SeatPattern = (typeof pattern)["seat"][SeatState];
export const seatColorNames = ${JSON.stringify(seatNames)} as const;

/** 중단점(px). 휴대폰 배치는 md 미만, 태블릿은 md 이상 lg 미만, 데스크톱은 lg 이상, 고밀도는 xl 이상(d1 §4). */
export const breakpoint = ${objLiteral(breakpoints.map((b) => [b.name, String(px(b.value))]), "")} as const;

/** 모션 길이(ms)와 이징 */
export const motion = {
  duration: ${objLiteral(durations.map((d) => [d.name, String(ms(d.value))]), "  ")},
  easing: ${objLiteral(easings.map((e) => [e.name, JSON.stringify(e.value)]), "  ")},
  seatShakeMs: ${ms(seatShake)},
  qrRotateMs: ${ms(qrRotate)},
} as const;

/** 간격(px). 이름은 tokens.json space와 같다(0_5 = 2px) */
export const space = ${objLiteral([...spaceScale, ...spaceSemantic].map((s) => [s.name, String(px(s.value))]), "")} as const;

export const radius = ${objLiteral(radius.map((r) => [r.name, String(px(r.value))]), "")} as const;

export const size = ${objLiteral(sizes.map((s) => [s.name, String(px(s.value))]), "")} as const;

export const layout = ${objLiteral(layout.map((l) => [l.name, String(px(l.value))]), "")} as const;

export const zIndex = ${objLiteral(zIndex.map((z) => [z.name, String(z.value)]), "")} as const;

export const fontFamily = ${objLiteral(fontFamily.map((f) => [f.name, JSON.stringify(f.value)]), "")} as const;
`;

// ---------------------------------------------------------------- kit-tokens.css
/** 대응표 한 칸을 [값, 출처 주석]으로. 경로가 tokens.json에 없으면 token()이 빌드를 멈춘다 */
function kitValue(ref) {
  if (typeof ref === "object") return [ref.raw, "tokens.json에 없음, 키트 값"];
  return [v(token(...ref.split("."))), ref];
}
const kitNames = KIT_VARS.map(([kit]) => kit);
if (new Set(kitNames).size !== kitNames.length) throw new Error("KIT_VARS에 같은 키트 변수가 두 번 있다");
const kitBlock = (selector, col) =>
  `  ${selector} {\n${KIT_VARS.filter((row) => row[col] !== null)
    .map(([kit, ...refs]) => {
      const [val, src] = kitValue(refs[col - 1]);
      return `    ${kit}: ${val}; /* ${src} */`;
    })
    .join("\n")}\n  }\n`;
const kitTokensCss =
  cssHeader +
  `/*
 * 캔버스 키트(src/styles/kit.css)의 변수 블록. 대응표는 scripts/build-tokens.mjs의 KIT_VARS다.
 * styles/index.css가 kit.css보다 먼저 싣는다. 변수 아닌 루트 속성(글꼴·줄 높이 등)은 kit.css 1절에 있다.
 * 키트 이름과 tokens.json 이름이 다른 것: --seat-held = seat.held-by-others, --r-* = radius.*
 */
@layer components {
${kitBlock(".pk", 1)}
${kitBlock(".pk.dark", 2)}}
`;

// ---------------------------------------------------------------- queue-room-tokens.css
// 대기실 경량 페이지(styles/queue-room.css, CSS 10KB 예산)용 같은 블록. 대기실이 쓰지 않는 좌석·SLO·heat·스위치 변수는 뺀다.
const QUEUE_ROOM_SKIP = /^--(seat|slo|heat)-|^--switch-off$/;
const queueVars = KIT_VARS.filter(([kit]) => !QUEUE_ROOM_SKIP.test(kit));
const queueBlock = (selector, col) =>
  `  ${selector} {\n${queueVars
    .filter((row) => row[col] !== null)
    .map(([kit, ...refs]) => `    ${kit}: ${kitValue(refs[col - 1])[0]};`)
    .join("\n")}\n  }\n`;
const queueRoomTokensCss =
  cssHeader +
  `/*
 * 대기실 경량 페이지의 키트 변수 블록(styles/queue-room.css가 맨 앞에서 싣는다). kit-tokens.css에서 좌석·SLO·heat·스위치 변수를 뺀 것이다.
 */
@layer components {
${queueBlock(".pk", 1)}
${queueBlock(".pk.dark", 2)}}
`;

// ---------------------------------------------------------------- 쓰기 또는 검사
const outputs = [
  ["tokens.css", tokensCss],
  ["theme.css", themeCss],
  ["tokens.ts", tokensTs],
  ["kit-tokens.css", kitTokensCss],
  ["queue-room-tokens.css", queueRoomTokensCss],
];

let changed = 0;
for (const [file, content] of outputs) {
  const path = resolve(outDir, file);
  const rel = relative(repoRoot, path).replaceAll("\\", "/");
  if (checkMode) {
    const onDisk = existsSync(path) ? readFileSync(path, "utf8").replaceAll("\r\n", "\n") : null;
    if (onDisk !== content) {
      changed += 1;
      console.error(`다름: ${rel}`);
    }
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path, content, "utf8");
    console.log(`만듦: ${rel}`);
  }
}
if (checkMode) {
  if (changed > 0) {
    console.error(`토큰 생성 파일 ${changed}개가 tokens.json과 맞지 않는다. 'pnpm --filter @peaket/ds tokens'로 다시 만든다.`);
    process.exit(1);
  }
  console.log("토큰 생성 파일이 tokens.json과 같다.");
}
