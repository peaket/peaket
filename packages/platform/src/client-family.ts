// 정규 로그 줄의 client: 브라우저 계열과 주 판만 남긴다. User-Agent 원문은 쓰지 않는다(ADR-0069 결정 11).
// 앞에서부터 먼저 맞는 것을 쓴다(Edge·삼성·웨일·오페라는 Chrome 표기를 함께 달고, Chrome은 Safari 표기를 함께 단다).
// identity-svc의 로그인한 기기 이름(ADR-0209 결정 1)도 같은 판별(browserFamily)을 쓴다. 규칙을 한 곳에 둔다(BOT-044 새 맥락 리뷰 낮음 8).

/** 판별하는 브라우저 계열 */
export type BrowserFamily = 'edge' | 'samsung' | 'whale' | 'opera' | 'firefox' | 'chrome' | 'safari';

const FAMILIES: ReadonlyArray<readonly [BrowserFamily, RegExp]> = [
  ['edge', /\bEdg(?:e|A|iOS)?\/(\d{1,4})/],
  ['samsung', /\bSamsungBrowser\/(\d{1,4})/],
  ['whale', /\bWhale\/(\d{1,4})/],
  ['opera', /\b(?:OPR|OPT)\/(\d{1,4})/],
  ['firefox', /\b(?:Firefox|FxiOS)\/(\d{1,4})/],
  ['chrome', /\b(?:Chrome|CriOS)\/(\d{1,4})/],
  ['safari', /\bVersion\/(\d{1,4})[^ ]* (?:Mobile\/\S+ )?Safari\//],
];
/** 이보다 긴 User-Agent는 앞부분만 본다(정규식이 긴 입력에 오래 걸리지 않게) */
const MAX_UA = 512;

function familyOf(userAgent: string): { family: BrowserFamily; major: number } | undefined {
  const ua = userAgent.slice(0, MAX_UA);
  for (const [family, re] of FAMILIES) {
    const m = re.exec(ua);
    if (m) return { family, major: Number(m[1]) };
  }
  return undefined;
}

export function clientFamily(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  const f = familyOf(userAgent);
  return f ? `${f.family}/${f.major}` : 'other';
}

/** 브라우저 계열만(판 번호 없이). 모르면 undefined */
export function browserFamily(userAgent: string | null | undefined): BrowserFamily | undefined {
  return userAgent ? familyOf(userAgent)?.family : undefined;
}
