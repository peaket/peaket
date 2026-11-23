// 증거 수집기 환경 값(docs/observability.md §5 '진단 증거', 시험 D-T51 ⑥). 틀리면 던져 시작하지 않는다(모든 환경에서 같다).
// - PEAKET_EVIDENCE_WEBHOOK_TOKEN: 웹훅 공유 토큰(필수, 빈 값 안 됨)
// - PEAKET_EVIDENCE_TARGETS: JSON 배열 [{"name","kind","urlEnv"}]. 비면 안 되고, 이름은 ^[a-z0-9-]+$이며 겹치지 않고, kind는 postgres·redis
// - 각 urlEnv가 가리키는 환경 값: 그 대상의 접속 주소(필수, 빈 값 안 됨). 주소는 오류 글에 싣지 않는다
import { TARGET_KINDS, type EvidenceTarget, type TargetKind } from './modules/collector/index.js';

export interface EvidenceCollectorConfig {
  webhookToken: string;
  targets: EvidenceTarget[];
}

const NAME = /^[a-z0-9-]+$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** 대상 수 상한 [가정](지표 라벨 target의 값 수를 묶는다, docs/observability.md §8) */
const MAX_TARGETS = 32;

export class EvidenceConfigError extends Error {
  override name = 'EvidenceConfigError';
}

export function loadEvidenceCollectorConfig(env: Record<string, string | undefined>): EvidenceCollectorConfig {
  const webhookToken = env.PEAKET_EVIDENCE_WEBHOOK_TOKEN;
  if (!webhookToken) throw new EvidenceConfigError('PEAKET_EVIDENCE_WEBHOOK_TOKEN이 없다(웹훅 공유 토큰, 비밀 관리에서 넣는다)');
  const raw = env.PEAKET_EVIDENCE_TARGETS;
  if (!raw) throw new EvidenceConfigError('PEAKET_EVIDENCE_TARGETS가 없다(수집 대상 목록)');
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new EvidenceConfigError('PEAKET_EVIDENCE_TARGETS가 JSON이 아니다');
  }
  if (!Array.isArray(list) || list.length === 0) throw new EvidenceConfigError('PEAKET_EVIDENCE_TARGETS가 비었거나 배열이 아니다');
  if (list.length > MAX_TARGETS) throw new EvidenceConfigError(`수집 대상이 ${MAX_TARGETS}개를 넘는다`);
  const targets: EvidenceTarget[] = [];
  list.forEach((item: unknown, i) => {
    const t = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const { name, kind, urlEnv } = t;
    if (typeof name !== 'string' || !NAME.test(name)) throw new EvidenceConfigError(`PEAKET_EVIDENCE_TARGETS[${i}].name이 ^[a-z0-9-]+$ 꼴이 아니다`);
    if (targets.some((x) => x.name === name)) throw new EvidenceConfigError(`수집 대상 이름 ${name}이(가) 겹친다`);
    if (typeof kind !== 'string' || !(TARGET_KINDS as readonly string[]).includes(kind)) throw new EvidenceConfigError(`수집 대상 ${name}의 kind는 ${TARGET_KINDS.join('·')} 가운데 하나여야 한다`);
    if (typeof urlEnv !== 'string' || !ENV_NAME.test(urlEnv)) throw new EvidenceConfigError(`수집 대상 ${name}의 urlEnv가 환경 값 이름 꼴이 아니다`);
    const url = env[urlEnv];
    if (!url) throw new EvidenceConfigError(`수집 대상 ${name}의 접속 주소(${urlEnv})가 없다`);
    targets.push({ name, kind: kind as TargetKind, url });
  });
  return { webhookToken, targets };
}
