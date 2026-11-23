// T-30분 점검 체크리스트와 Go/No-Go 판정 자리(F-03-3 OPS-380, C-T25 ①, docs/features/control-tower.md §2 'T-30분 점검'·'Go/No-Go 판정', d5 §7.2 CMP-009).
// 값은 GET /v1/ops/events/{eventId}/readiness(또는 위젯 키 ops-readiness.checklist)이고 서버가 판정 미리 보기까지 계산한다(화면은 다시 판정하지 않는다).
// 항목마다 상태를 글자로 보이고(WCAG 1.4.1) '이 환경에 없음'·'확인할 수 없음'은 배지로 둔다. [Go/No-Go 판정]은 operator·commander에만 있다(viewer·CS·휴대폰에는 없다).
import { recentRange, type TimeRange } from '@/shared/lib/links';
import { DetailAnchor, fmt, JudgementLine, kst } from './frame';

export type ReadinessStatus = 'pass' | 'fail' | 'unknown' | 'not-in-env' | 'deferred' | 'display-only';
export interface ReadinessItem {
  key: string;
  group: 'required' | 'recommended' | 'display';
  status: ReadinessStatus;
  value?: number;
  unit?: string;
  at?: string;
  reason?: string;
}
export interface ReadinessPreview {
  verdict: 'go' | 'no-go';
  failedRequired: string[];
  failedRecommended: string[];
}
export interface JudgementSummary {
  judgementId: string;
  verdict: 'go' | 'no-go';
  failedRequired: string[];
  failedRecommended: string[];
  judgedAt: string;
  sequence: number;
}
export interface Readiness {
  eventId: string;
  stage: string;
  schedule?: { opensAt: string; saleEndsAt: string; entryOpensAt?: string; entryClosedAt?: string };
  items: ReadinessItem[];
  preview: ReadinessPreview;
  judgeableFrom?: string;
  judgeableUntil?: string;
  lastJudgement?: JudgementSummary;
}

/** 항목 글(control-tower §2 T-30분 점검 칸, d5 §7.2 체크리스트) */
export const ITEM_LABEL: Record<string, string> = {
  prewarm: '프리워밍(최소 복제 수 미달이면 RB-02)',
  datastores: 'Redis·Kafka·PostgreSQL 헬스',
  'payment-provider': '그 공연 결제사 상태와 한도 초과 응답 없음',
  'identity-providers': '본인확인·사람 확인 제공자',
  'cdn-limits': 'CloudFront 배포별 한도 ≥ 그 회차 설계 피크',
  synthetic: '대기실·상세·결제 종합 합성 점검',
  'oncall-test': '온콜 채널 시험 발송',
  'clock-offset': '시계 오프셋 ≤ 20ms',
  credentials: '갱신이 늦은 인증서(SEV2 기준) 없음·배치 기기 자격이 역할 유효 끝 뒤까지 유효',
  'cross-region-backup': '마지막 교차 리전 백업 성공',
  deployments: '진행 중 배포 0건(대형·중형 공연)',
  'freeze-window': '변경 동결 창 적용',
  'managed-maintenance': '겹치는 관리형 유지보수 없음',
  'cdn-hit-ratio': 'CDN 엣지 캐시 적중률(직전 15분 90% 이상, 요청 1,000건 미만은 판정 보류)',
  'demand-forecast': '수요 예측 상단 ≤ 규모 등급 상한',
  'pg-assignment': '결제사 기본·대체(명령 12 지정)',
};
export const itemLabel = (key: string): string => ITEM_LABEL[key] ?? key;

const STATUS_TEXT: Record<ReadinessStatus, string> = {
  pass: '통과',
  fail: '실패',
  unknown: '확인할 수 없음',
  'not-in-env': '이 환경에 없음',
  deferred: '판정 보류',
  'display-only': '표시만',
};
const STATUS_CLASS: Record<ReadinessStatus, string> = {
  pass: 'slo slo-ok',
  fail: 'slo slo-breached',
  unknown: 'slo slo-stale',
  'not-in-env': 'badge badge-outline',
  deferred: 'slo slo-burning',
  'display-only': 'badge',
};
const REASON_TEXT: Record<string, string> = {
  'source-unavailable': '원천을 읽지 못했습니다',
  'source-not-built': '원천 기능이 아직 없습니다',
  'no-sample': '최근 5분 표본이 없습니다',
};

function valueText(i: ReadinessItem): string {
  if (typeof i.value !== 'number') return '';
  if (i.unit === 'ms') return `${fmt(i.value, 3)}ms`;
  if (i.unit === 'ratio') return `${fmt(i.value * 100, 1)}%`;
  if (i.unit === 'requests') return `요청 ${fmt(i.value)}건`;
  return fmt(i.value);
}

function ItemRow({ i }: { i: ReadinessItem }) {
  const meta = [valueText(i), i.reason ? (REASON_TEXT[i.reason] ?? i.reason) : '', i.at ? kst(i.at) : ''].filter((x) => x !== '').join(' · ');
  return (
    <li className="row" style={{ gap: 12, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <span className="col grow" style={{ gap: 2 }}>
        <span className="t-sm fw-m">{itemLabel(i.key)}</span>
        {meta ? <span className="t-xs muted">{meta}</span> : null}
      </span>
      <span className={STATUS_CLASS[i.status] ?? 'slo slo-stale'}>{STATUS_TEXT[i.status] ?? '확인할 수 없음'}</span>
    </li>
  );
}

const GROUPS: { group: ReadinessItem['group']; title: string }[] = [
  { group: 'required', title: '필수 · 하나라도 실패하면 No-Go(확인할 수 없음도 실패로 셉니다)' },
  { group: 'recommended', title: '권고 · 실패하면 사유를 적고 계속합니다' },
  { group: 'display', title: '표시 · 판정에 들지 않습니다' },
];

export const canJudge = (role: string | null | undefined): boolean => role === 'operator' || role === 'commander';

export interface ReadinessChecklistProps {
  readiness: Readiness;
  role: string | null | undefined;
  /** [Go/No-Go 판정]을 눌렀을 때(대화상자를 연다) */
  onJudge?: () => void;
  range?: TimeRange;
  /** 판정 창 안인가(없으면 judgeableFrom·judgeableUntil과 지금 시각으로 본다) */
  nowMs?: number;
}

export function ReadinessChecklist({ readiness, role, onJudge, range, nowMs }: ReadinessChecklistProps) {
  const r = readiness;
  const req = r.items.filter((i) => i.group === 'required');
  const rec = r.items.filter((i) => i.group === 'recommended');
  const reqPass = req.filter((i) => i.status === 'pass').length;
  const span = range ?? recentRange();
  const now = nowMs ?? Date.now();
  const from = r.judgeableFrom ? Date.parse(r.judgeableFrom) : Number.NEGATIVE_INFINITY;
  const until = r.judgeableUntil ? Date.parse(r.judgeableUntil) : Number.POSITIVE_INFINITY;
  const windowOpen = !(now < from) && !(now > until);
  const noGo = r.preview.verdict === 'no-go';
  return (
    <>
      <section className="widget" role="region" aria-labelledby="w-pf" style={{ gridColumn: 'span 3' }}>
        <div className="widget-head wrap">
          <h2 className="t-sm fw-b" id="w-pf">{`T-30분 점검 · 필수 ${req.length} · 권고 ${rec.length}`}</h2>
          <div className="actions" style={{ gap: 12 }}>
            <DetailAnchor title="T-30분 점검" panel="readiness" eventId={r.eventId} range={span} />
          </div>
        </div>
        <div className="widget-body" style={{ gap: 4 }}>
          {GROUPS.map(({ group, title }) => {
            const list = r.items.filter((i) => i.group === group);
            if (list.length === 0) return null;
            return (
              <div key={group} className="col" style={{ gap: 4 }}>
                <h3 className="eyebrow">{title}</h3>
                <ul className="col">
                  {list.map((i) => (
                    <ItemRow key={i.key} i={i} />
                  ))}
                </ul>
              </div>
            );
          })}
          <JudgementLine widgetKey="ops-readiness.checklist" />
        </div>
      </section>
      <aside className="widget" role="region" aria-labelledby="w-gng">
        <div className="widget-head">
          <h2 className="t-sm fw-b" id="w-gng">
            Go/No-Go 판정
          </h2>
        </div>
        <div className="widget-body">
          <div className={noGo ? 'stat is-breached' : 'stat'}>
            <span className="stat-label">지금 결과</span>
            <span className="stat-value">{noGo ? 'No-Go' : 'Go'}</span>
            <span className={noGo ? 'slo slo-breached' : 'slo slo-ok'}>{`필수 ${reqPass}/${req.length} 통과 · ${r.preview.failedRequired.length}개 실패`}</span>
            {r.preview.failedRequired.length + r.preview.failedRecommended.length > 0 ? (
              <span className="stat-meta">
                {[
                  r.preview.failedRequired.length > 0 ? `실패: ${r.preview.failedRequired.map(itemLabel).join(' · ')}` : '',
                  r.preview.failedRecommended.length > 0 ? `권고 실패 ${r.preview.failedRecommended.length}: ${r.preview.failedRecommended.map(itemLabel).join(' · ')}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            ) : null}
          </div>
          {canJudge(role) ? (
            <button className="btn btn-primary btn-block" type="button" onClick={onJudge} disabled={!windowOpen} aria-describedby="w-gng-window">
              {r.lastJudgement ? 'Go/No-Go 판정 다시 하기' : 'Go/No-Go 판정하기'}
            </button>
          ) : null}
          <p className="t-xs muted" id="w-gng-window">
            {r.judgeableUntil ? `판정은 ${kst(r.judgeableUntil)}(오픈 20분 전)까지 받습니다. 그때까지 판정이 없으면 No-Go로 봅니다.` : '판정 창 시각을 받지 못했습니다.'}
          </p>
          <div className="divider" />
          <h3 className="eyebrow">판정 기록</h3>
          {r.lastJudgement ? (
            <p className="t-sm">
              {`${r.lastJudgement.sequence}번째 판정 · ${r.lastJudgement.verdict === 'go' ? 'Go' : 'No-Go'} · ${kst(r.lastJudgement.judgedAt)}`}
              {r.lastJudgement.failedRequired.length > 0 ? ` · 실패 ${r.lastJudgement.failedRequired.map(itemLabel).join(' · ')}` : ''}
            </p>
          ) : (
            <p className="t-sm muted">이 회차의 판정이 아직 없습니다. 판정과 사유는 감사 로그에 남습니다.</p>
          )}
        </div>
      </aside>
    </>
  );
}
