// 지표 이름·라벨 규칙 검사(ADR-0334 결정 6, docs/observability.md §8 '메트릭 카디널리티 규칙', 시험 C-T76).
// createService의 listen이 듣기 전에 서비스 레지스트리에 등록된 지표 전부를 훑고, 어기면 어긴 지표 이름과 라벨을 모두 들어 시작을 실패시킨다(환경과 관계없이 같다).
// - 라벨 이름은 소문자로 바꾸고 `_`·`-`를 뺀 뒤 금지 이름과 견준다. `token`·`ip`로 끝나는 이름도 금지다
// - 지표 이름은 Prometheus 이름 규칙(`[a-zA-Z_:][a-zA-Z0-9_:]*`), 라벨 이름은 라벨 이름 규칙(`[a-zA-Z_][a-zA-Z0-9_]*`)을 따르고, Counter는 `_total`로 끝난다
// listen 뒤에 등록한 지표는 보지 않는다(서비스는 듣기 전에 지표를 만든다)
import type { Registry } from '@prometheus-io/client';

export interface MetricRuleViolation {
  /** 어긴 지표 이름 */
  metric: string;
  /** 어긴 라벨 이름(라벨 규칙일 때만) */
  label?: string;
  /** forbidden-label: 금지 라벨, name: 이름 규칙, counter-total: Counter 이름이 _total로 끝나지 않음 */
  rule: 'forbidden-label' | 'name' | 'counter-total';
}

/** docs/observability.md §8 '사용 금지 라벨'을 이름으로 옮긴 것(소문자, `_`·`-`를 뺀 꼴, ADR-0334 결정 6) */
const FORBIDDEN_LABELS: ReadonlySet<string> = new Set(['accountid', 'userid', 'pid', 'sid', 'sessionid', 'ci', 'token', 'queueseq', 'seq', 'seatid', 'ip', 'clientip', 'useragent', 'ua', 'orderid']);
/** 이 꼬리로 끝나는 라벨 이름도 금지다(세션 토큰·클라이언트 IP 꼴, ADR-0334 결정 6) */
const FORBIDDEN_SUFFIXES: readonly string[] = ['token', 'ip'];
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** 라벨 이름이 금지 라벨인가(소문자로 바꾸고 `_`·`-`를 뺀 뒤 견준다) */
export function isForbiddenMetricLabel(label: string): boolean {
  const n = label.toLowerCase().replace(/[_-]/g, '');
  return FORBIDDEN_LABELS.has(n) || FORBIDDEN_SUFFIXES.some((s) => n.endsWith(s));
}

/** 레지스트리에 등록된 지표 전부를 훑어 어긴 것을 모두 돌려준다(빈 목록이면 통과). 등록 지표가 0개인 것은 부르는 쪽이 본다 */
export function validateMetricRegistry(registry: Registry): readonly MetricRuleViolation[] {
  const out: MetricRuleViolation[] = [];
  for (const m of registry.getMetricsAsArray()) {
    const metric = String(m.name);
    if (!METRIC_NAME.test(metric)) out.push({ metric, rule: 'name' });
    if (m.type === 'counter' && !metric.endsWith('_total')) out.push({ metric, rule: 'counter-total' });
    // 라벨 이름 목록은 지표 객체에 있다(형 정의의 MetricObject에는 없다)
    const labels = (m as { labelNames?: readonly unknown[] }).labelNames ?? [];
    for (const raw of labels) {
      const label = String(raw);
      if (!LABEL_NAME.test(label)) out.push({ metric, label, rule: 'name' });
      if (isForbiddenMetricLabel(label)) out.push({ metric, label, rule: 'forbidden-label' });
    }
  }
  return out;
}

const RULE_TEXT: Record<MetricRuleViolation['rule'], string> = {
  'forbidden-label': '금지 라벨',
  name: '이름 규칙',
  'counter-total': 'Counter 이름은 _total로 끝난다',
};

/** 어긴 것을 사람이 읽는 글로(지표 이름과 라벨을 모두 든다) */
export function describeMetricViolations(violations: readonly MetricRuleViolation[]): string {
  return violations.map((v) => (v.label === undefined ? `${v.metric}(${RULE_TEXT[v.rule]})` : `${v.metric}의 라벨 ${v.label}(${RULE_TEXT[v.rule]})`)).join(', ');
}
