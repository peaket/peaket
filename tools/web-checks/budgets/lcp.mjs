// Lighthouse 13.5의 LCP 분해(lcp-breakdown-insight)·발견 경로(lcp-discovery-insight)·그리기를 막는 자원(render-blocking-insight)을
// 기록 파일(runs[].lcp·lcpSummary)에 남길 모양으로 읽는다(BAT-177, docs/frontend.md §5.8). 판정에는 쓰지 않는다(진단용).
// lcp-breakdown-insight의 details는 목록(type 'list')이고 그 안에 구간 표(type 'table')와 요소(type 'node')가 들어 있다.
// 구간 표의 duration은 ms다(초가 아니다). 요소가 없어도 구간만 있으면 구간을 돌려준다.

/** snippet의 data URI 본문을 줄이고 300자에서 자른다(산출물이 수 KB로 불어나지 않게) */
const SNIPPET_MAX = 300;

/**
 * data:image/…;base64,… 꼬리를 `data:image/png;base64,…` 꼴로 줄인다.
 * @param {unknown} value
 * @returns {string | null}
 */
function shortenSnippet(value) {
  if (typeof value !== 'string') return null;
  const shortened = value.replace(/data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,[a-z0-9+/=]+/gi, 'data:$1;base64,…');
  return shortened.length > SNIPPET_MAX ? `${shortened.slice(0, SNIPPET_MAX - 1)}…` : shortened;
}

/**
 * 구간 표의 items에서 네 구간을 ms로 읽는다. 없는 구간(글자 LCP의 불러오기 지연·불러오기)은 0이다.
 * 알아보는 구간이 하나도 없으면 null
 * @param {unknown} items
 * @returns {{ ttfbMs: number, loadDelayMs: number, loadDurationMs: number, renderDelayMs: number } | null}
 */
function readPhases(items) {
  if (!Array.isArray(items)) return null;
  const bySubpart = new Map();
  for (const item of items) {
    if (item && typeof item.subpart === 'string' && typeof item.duration === 'number' && Number.isFinite(item.duration)) bySubpart.set(item.subpart, item.duration);
  }
  if (bySubpart.size === 0) return null;
  const ms = (subpart) => (bySubpart.has(subpart) ? bySubpart.get(subpart) : 0);
  return {
    ttfbMs: ms('timeToFirstByte'),
    loadDelayMs: ms('resourceLoadDelay'),
    loadDurationMs: ms('resourceLoadDuration'),
    renderDelayMs: ms('elementRenderDelay'),
  };
}

/**
 * node 항목에서 LCP 요소를 읽는다.
 * @param {{ selector?: unknown, snippet?: unknown, nodeLabel?: unknown, boundingRect?: { width?: unknown, height?: unknown } | null }} node
 */
function readElement(node) {
  const rect = node.boundingRect;
  return {
    selector: typeof node.selector === 'string' ? node.selector : null,
    snippet: shortenSnippet(node.snippet),
    nodeLabel: typeof node.nodeLabel === 'string' ? node.nodeLabel : null,
    boundingRect: typeof rect?.width === 'number' && typeof rect?.height === 'number' ? { width: rect.width, height: rect.height } : null,
  };
}

/** IcuMessage(객체)나 글자를 표에 실을 글자로 바꾼다 */
function labelText(label) {
  if (typeof label === 'string') return label;
  const id = label?.i18nId;
  return typeof id === 'string' ? id.slice(id.lastIndexOf('|') + 1).trim() : '';
}

/**
 * lcp-discovery-insight의 체크 목록을 {label, value}[]로 읽는다. 목록이 없으면 null
 * @param {Record<string, any> | undefined} audit
 */
function readDiscovery(audit) {
  if (!audit || audit.errorMessage) return null;
  const items = Array.isArray(audit.details?.items) ? audit.details.items : [];
  const rows = [];
  for (const item of items) {
    if (item?.type !== 'checklist') continue;
    const raw = Array.isArray(item.items) ? item.items : item.items && typeof item.items === 'object' ? Object.values(item.items) : [];
    for (const row of raw) {
      if (row && typeof row === 'object') rows.push({ label: labelText(row.label), value: row.value });
    }
  }
  return rows.length ? rows : null;
}

/**
 * render-blocking-insight의 표에서 그리기를 막는 자원을 읽는다. 없으면 null
 * @param {Record<string, any> | undefined} audit
 */
function readRenderBlocking(audit) {
  if (!audit || audit.errorMessage) return null;
  const items = Array.isArray(audit.details?.items) ? audit.details.items : [];
  const rows = [];
  for (const item of items) {
    if (!item || typeof item.url !== 'string') continue;
    rows.push({
      url: item.url,
      totalBytes: typeof item.totalBytes === 'number' ? item.totalBytes : null,
      wastedMs: typeof item.wastedMs === 'number' ? item.wastedMs : null,
    });
  }
  return rows.length ? rows : null;
}

/**
 * Lighthouse 감사 결과에서 LCP 요소·네 구간·진단을 읽는다.
 * 감사가 없거나 오류면 null, 요소와 구간이 둘 다 없으면 null. 던지지 않는다(기록 파일을 잃지 않는다)
 * @param {Record<string, any> | undefined} audits
 * @returns {{ element: { selector: string | null, snippet: string | null, nodeLabel: string | null, boundingRect: { width: number, height: number } | null } | null, phases: { ttfbMs: number, loadDelayMs: number, loadDurationMs: number, renderDelayMs: number } | null, discovery: { label: string, value: unknown }[] | null, renderBlocking: { url: string, totalBytes: number | null, wastedMs: number | null }[] | null } | null}
 */
export function readLcp(audits) {
  const breakdown = audits?.['lcp-breakdown-insight'];
  if (!breakdown || breakdown.errorMessage) return null;
  const items = Array.isArray(breakdown.details?.items) ? breakdown.details.items : [];
  const table = items.find((item) => item?.type === 'table');
  const node = items.find((item) => item?.type === 'node');
  const phases = table ? readPhases(table.items) : null;
  const element = node ? readElement(node) : null;
  if (!element && !phases) return null;
  return {
    element,
    phases,
    discovery: readDiscovery(audits?.['lcp-discovery-insight']),
    renderBlocking: readRenderBlocking(audits?.['render-blocking-insight']),
  };
}

/**
 * 다섯 회의 LCP 가운데 값 회차를 요약한다. 회차는 lcpMs 작은 차례로 늘어놓았을 때 가운데(짝수는 가운데 둘 중 아래)다.
 * 회차 값의 평균을 쓰지 않는다(요소가 섞이면 평균이 뜻을 잃는다). 모든 회차에 lcp가 없으면 null
 * @param {{ lcpMs?: number, lcp?: { element?: { selector?: string | null } | null, phases?: unknown } | null }[]} runs
 */
export function lcpSummary(runs) {
  const rows = Array.isArray(runs) ? runs : [];
  if (rows.length === 0 || !rows.some((run) => run?.lcp)) return null;
  const sorted = rows
    .map((run, index) => ({ index, lcpMs: run?.lcpMs }))
    .filter((row) => typeof row.lcpMs === 'number' && Number.isFinite(row.lcpMs))
    .sort((a, b) => a.lcpMs - b.lcpMs);
  if (sorted.length === 0) return null;
  const middle = Math.floor((sorted.length - 1) / 2);
  const chosen = rows[sorted[middle].index];
  const elements = [];
  for (const run of rows) {
    const selector = run?.lcp?.element?.selector;
    if (typeof selector === 'string' && !elements.includes(selector)) elements.push(selector);
  }
  return {
    run: middle + 1,
    lcpMs: sorted[middle].lcpMs,
    element: chosen?.lcp?.element ?? null,
    phases: chosen?.lcp?.phases ?? null,
    elements,
  };
}
