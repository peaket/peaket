// 관제 메뉴(d5 §3.3 '역할별 메뉴 표', docs/planning/03 §3 권한 매트릭스를 화면 메뉴로 옮긴 것).
// 표의 '—'인 화면은 그 역할의 메뉴에서 뺀다. 순서와 묶음·아이콘은 디자인 캔버스 보드의 왼쪽 내비 그대로다.
// 봇 표본 검토(SCR-067)는 commander 보드에 없어(표에서 cs_agent·cs_lead만 검토) 'CS·승인' 묶음 끝에 둔다(추천안).
// '부정 거래 조사'(SCR-070·071)는 역할이 아니라 지정으로 그린다: commander·cs_lead이면서 부정 거래 조사관 지정(FRAUD_INVESTIGATOR)이 있을 때만,
// 법정 조치 바로 아래(control-tower §9.2, d5 §3.3 '지정 메뉴'). 캔버스 보드가 없는 항목이다(add-fraud-investigation-screens).
import type { ConsoleNavGroup, ConsoleRole, ConsoleTabItem } from '@peaket/ds/ConsoleShell';

type Key =
  | 'dashboard'
  | 'commands'
  | 'audit'
  | 'compliance'
  | 'investigations'
  | 'cs-inbox'
  | 'customers'
  | 'cs-approvals'
  | 'cancellations'
  | 'bot-review'
  | 'sale-reviews'
  | 'settlements'
  | 'partners'
  | 'scanner-devices'
  | 'accounts'
  | 'notices';

const ALL: Record<ConsoleRole, readonly Key[]> = {
  viewer: ['dashboard', 'commands', 'audit', 'compliance', 'cancellations', 'sale-reviews', 'settlements', 'scanner-devices', 'notices'],
  operator: ['dashboard', 'commands', 'audit', 'compliance', 'cs-inbox', 'customers', 'cs-approvals', 'cancellations', 'sale-reviews', 'settlements', 'partners', 'scanner-devices', 'accounts', 'notices'],
  commander: ['dashboard', 'commands', 'audit', 'compliance', 'cs-inbox', 'customers', 'cs-approvals', 'cancellations', 'sale-reviews', 'settlements', 'partners', 'scanner-devices', 'accounts', 'notices'],
  cs_agent: ['dashboard', 'audit', 'compliance', 'cs-inbox', 'customers', 'cs-approvals', 'cancellations', 'bot-review', 'sale-reviews', 'partners'],
  cs_lead: ['dashboard', 'audit', 'compliance', 'cs-inbox', 'customers', 'cs-approvals', 'cancellations', 'bot-review', 'sale-reviews', 'partners'],
};

/** 메뉴 항목(화면 경로는 router.tsx의 경로 표와 같다). 목업 회차의 요청·공연 ID를 채운 주소다 */
const ITEMS: Record<Key, { label: string; href: string; icon: string; badge?: { text: string; tone?: 'warning' } }> = {
  dashboard: { label: '대시보드', href: '/dashboard', icon: 'chart' },
  commands: { label: '운영 명령', href: '/commands', icon: 'bolt' },
  audit: { label: '감사·리플레이', href: '/audit', icon: 'history' },
  compliance: { label: '법정 조치', href: '/compliance', icon: 'scale' },
  investigations: { label: '부정 거래 조사', href: '/investigations', icon: 'shield' },
  'cs-inbox': { label: 'CS 처리함', href: '/cs/inbox', icon: 'inbox', badge: { text: '7', tone: 'warning' } },
  customers: { label: '팬 조회', href: '/customers', icon: 'search' },
  'cs-approvals': { label: '승인 업무', href: '/cs/approvals', icon: 'stamp', badge: { text: '1' } },
  cancellations: { label: '회차 취소', href: '/cancellations/cr-lumen-r1', icon: 'ban' },
  'bot-review': { label: '봇 표본 검토', href: '/bot-review', icon: 'bot' },
  'sale-reviews': { label: '판매 승인', href: '/sale-reviews/prd-lumen-2026', icon: 'check-circle' },
  settlements: { label: '정산 지급', href: '/settlements', icon: 'won' },
  partners: { label: '파트너사', href: '/partners', icon: 'building' },
  'scanner-devices': { label: '스캐너 기기', href: '/scanner-devices', icon: 'device' },
  accounts: { label: '계정·세션', href: '/accounts', icon: 'key' },
  notices: { label: '공지 관리', href: '/notices', icon: 'megaphone' },
};

const GROUPS: { title?: string; keys: Key[] }[] = [
  { keys: ['dashboard', 'commands', 'audit', 'compliance', 'investigations'] },
  { title: 'CS·승인', keys: ['cs-inbox', 'customers', 'cs-approvals', 'cancellations', 'bot-review'] },
  { title: '판매·정산', keys: ['sale-reviews', 'settlements', 'partners'] },
  { title: '현장·계정', keys: ['scanner-devices', 'accounts', 'notices'] },
];

/** 지정이 있어야 보이는 메뉴(역할 표 ALL과 따로 본다) */
const DESIGNATED: Partial<Record<Key, { roles: readonly ConsoleRole[]; designation: string }>> = {
  investigations: { roles: ['commander', 'cs_lead'], designation: 'FRAUD_INVESTIGATOR' },
};

export function navFor(role: ConsoleRole, designations: readonly string[] = []): ConsoleNavGroup[] {
  const allowed = new Set<Key>(ALL[role]);
  for (const [k, rule] of Object.entries(DESIGNATED) as [Key, { roles: readonly ConsoleRole[]; designation: string }][]) {
    if (rule.roles.includes(role) && designations.includes(rule.designation)) allowed.add(k);
  }
  return GROUPS.map((g) => ({
    title: g.title,
    items: g.keys.filter((k) => allowed.has(k)).map((k) => ({ key: k, ...ITEMS[k] })),
  })).filter((g) => g.items.length > 0);
}

/** 주소에서 지금 메뉴 항목을 찾는다 */
export function navKeyFor(pathname: string): string | undefined {
  const hit = (Object.keys(ITEMS) as Key[]).find((k) => {
    const base = ITEMS[k].href.split('/').slice(0, 2).join('/');
    return pathname === ITEMS[k].href || pathname.startsWith(base + '/') || pathname === base;
  });
  return hit;
}

/** 휴대폰 아래 탭 막대(d5 §3.3): 대시보드 · 명령 · 경보 · 승인(내 승인 대기) · 메뉴 */
export function tabsFor(role: ConsoleRole, myApprovals: number): ConsoleTabItem[] {
  const tabs: ConsoleTabItem[] = [
    { key: 'dashboard', label: '대시보드', href: '/dashboard', icon: 'chart' },
    { key: 'commands', label: '명령', href: '/commands', icon: 'bolt' },
    { key: 'alerts', label: '경보', href: '/dashboard#w-alert', icon: 'alert' },
    { key: 'approvals', label: '승인', href: '/commands', icon: 'stamp', badge: myApprovals > 0 ? String(myApprovals) : undefined },
    { key: 'menu', label: '메뉴', href: '#menu', icon: 'menu' },
  ];
  // 명령 메뉴가 없는 역할(cs)은 승인 탭을 승인 업무로 보낸다
  if (role === 'cs_agent' || role === 'cs_lead') {
    return tabs.map((t) => (t.key === 'commands' ? { ...t, label: 'CS', href: '/cs/inbox', icon: 'inbox' } : t.key === 'approvals' ? { ...t, href: '/cs/approvals' } : t));
  }
  return tabs;
}

export function tabKeyFor(pathname: string, hash: string): string | undefined {
  if (pathname.startsWith('/dashboard')) return hash === '#w-alert' ? 'alerts' : 'dashboard';
  if (pathname.startsWith('/commands')) return 'commands';
  return undefined;
}
