// 콘솔 밖 도구 링크(F-03-3 OPS-380, docs/features/control-tower.md §2·§8·§12, ADR-0067·0371, docs/security/asvs/control-tower.md 1.2.2·3.7.2).
// - detailHref: 위젯 머리 '자세히 보기 ↗'. 빌드 값의 Grafana(오류 위젯은 Sentry) 주소 틀에 회차 ID·시작·끝 시각(과 패널 이름)만 URLSearchParams로 담는다(값을 글로 이어 붙이지 않는다)
// - safeAlertHref: 경보 본문의 런북·대시보드·실패 사건 보기 주소. https이고 빌드 값의 허용 호스트와 정확히 같을 때만 링크로 쓴다(앞부분 일치·사용자 정보 속임은 거절)
// 콘솔은 정적 앱이라 실행 때 설정 파일이 없다. 값은 빌드 때 PEAKET_CONSOLE_GRAFANA_URL·PEAKET_CONSOLE_SENTRY_URL·PEAKET_CONSOLE_LINK_HOSTS로 들어온다.

/** 빌드 값이 없을 때(퍼블리싱·local)의 목업 주소. entities/alert의 목업 상수와 같은 값이다(shared는 entities를 가져오지 않는다) */
const MOCK_GRAFANA = 'https://grafana.ops.peaket.example/d/onsale';
const MOCK_SENTRY = 'https://sentry.ops.peaket.example/issues';

const read = (v: () => string): string => {
  try {
    return v();
  } catch {
    return '';
  }
};

/** 빌드 값(비면 빈 글). 시험은 전역으로 넣는다 */
const grafanaBase = (): string => read(() => (typeof __CONSOLE_GRAFANA_URL__ === 'string' ? __CONSOLE_GRAFANA_URL__ : '')) || MOCK_GRAFANA;
const sentryBase = (): string => read(() => (typeof __CONSOLE_SENTRY_URL__ === 'string' ? __CONSOLE_SENTRY_URL__ : '')) || MOCK_SENTRY;
const linkHosts = (): Set<string> =>
  new Set(
    read(() => (typeof __CONSOLE_LINK_HOSTS__ === 'string' ? __CONSOLE_LINK_HOSTS__ : ''))
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  );

export interface DetailTarget {
  kind: 'grafana' | 'sentry';
  /** 패널 이름(위젯마다) */
  panel: string;
  eventId: string | null | undefined;
  fromMs: number;
  toMs: number;
}

/** '자세히 보기 ↗' 주소. 주소 틀의 원점·경로는 그대로 두고 쿼리만 새로 쓴다 */
export function detailHref(t: DetailTarget): string {
  const base = new URL(t.kind === 'sentry' ? sentryBase() : grafanaBase());
  base.hash = '';
  const q = new URLSearchParams();
  if (t.kind === 'sentry') {
    // Sentry 이슈 검색: 회차 태그와 시간 범위
    if (t.eventId) q.set('query', `event_id:${t.eventId}`);
    q.set('start', new Date(t.fromMs).toISOString());
    q.set('end', new Date(t.toMs).toISOString());
  } else {
    q.set('var-event', t.eventId ?? '');
    q.set('from', String(t.fromMs));
    q.set('to', String(t.toMs));
    q.set('viewPanel', t.panel);
  }
  base.search = q.toString();
  return base.href;
}

/** 경보 링크로 쓸 수 있는 주소면 정규화한 href, 아니면 null(글자로만 보인다) */
export function safeAlertHref(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  // 상대 주소(//host, /path)는 받지 않는다: 절대 https 주소만
  if (!/^https:\/\//i.test(raw.trim())) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null;
  if (!linkHosts().has(u.hostname.toLowerCase())) return null;
  if (u.port !== '') return null;
  return u.href;
}

/** 새 탭 링크 속성(opener 없음, ADR-0067) */
export const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** 시간 범위(밀리초) */
export interface TimeRange {
  fromMs: number;
  toMs: number;
}

/** 지금부터 15분 [가정] 앞까지(위젯 그래프 창과 같다) */
export function recentRange(nowMs = Date.now(), spanMs = 15 * 60_000): TimeRange {
  return { fromMs: nowMs - spanMs, toMs: nowMs };
}
