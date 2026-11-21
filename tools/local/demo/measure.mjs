// BAT-086 측정 기록(docs/review/plans/BAT-086.md §5 '측정 파일 계약', G7).
// - 재생 결과를 사람이 읽는 Markdown으로 쓴다. 실패한 실행도 지우지 않고 결과·실패 단계와 함께 남긴다(계획 B14).
// - 비밀·토큰·쿠키는 어떤 칸에도 싣지 않는다(V-T7 ⑥). redact()가 방어선이다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 비밀·토큰이 측정 파일에 새지 않게 가린다. 값의 모양을 지우고 이름만 남긴다 */
export function redact(text) {
  return String(text ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <가림>')
    .replace(/((?:password|passwd|totp|totpSeed|privateKey|private_key|credentialId|secret|token)\s*["']?\s*[:=]\s*)(["']?)[^\s"',;)}]+/gi, '$1$2<가림>')
    .replace(/__Secure-peaket_(at|rt)=[^;\s]+/g, '__Secure-peaket_$1=<가림>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<JWT 가림>');
}

/** 초를 사람이 읽는 꼴로(정수 초). 실패·미실행은 그대로 표시한다 */
export function seconds(v) {
  return Number.isFinite(v) ? `${Math.round(v)}초` : '—';
}

/**
 * 측정 결과 한 건의 Markdown. 계약: 커밋·날짜·PC/OS·도구 판·콜드 스타트·시나리오별 결과·정리 결과.
 * @param {{
 *   commit: string, date: string, pc: string, tools: Record<string, string>,
 *   coldStartSeconds?: number, totalSeconds?: number, scenarios: Array<{ id: string, title: string, startedAt?: string, endedAt?: string, seconds?: number, result: '통과'|'실패'|'미실행', failedStep?: string, reason?: string }>,
 *   cleanup?: string, command?: string, notes?: string[], outcome?: string,
 * }} r
 */
export function measurementText(r) {
  const lines = [];
  lines.push('# BAT-086 데모 재현 측정', '');
  lines.push(`- **커밋**: ${r.commit}`);
  lines.push(`- **날짜**: ${r.date}`);
  lines.push(`- **PC/OS**: ${r.pc}`);
  lines.push(`- **도구 판**: ${Object.entries(r.tools).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  lines.push(`- **명령**: \`${r.command ?? 'node tools/local/demo.mjs all'}\``);
  lines.push(`- **콜드 스타트**: ${seconds(r.coldStartSeconds)} (명령 시작 ~ 첫 화면)`);
  lines.push(`- **전체 시간**: ${seconds(r.totalSeconds)} (명령 시작 ~ 재생 끝)`);
  lines.push(`- **정리**: ${r.cleanup ?? '—'}`);
  lines.push(`- **결과**: ${r.outcome ?? (r.scenarios.every((s) => s.result === '통과') ? '통과' : '실패')}`);
  lines.push('', '## 시나리오별', '', '| # | 시나리오 | 시작 | 끝 | 걸린 시간 | 결과 | 실패 단계·까닭 |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of r.scenarios) {
    const why = s.result === '통과' ? '' : [s.failedStep ? `단계 ${s.failedStep}` : '', s.reason ?? ''].filter(Boolean).join(' · ');
    lines.push(`| ${s.id} | ${s.title} | ${s.startedAt ?? '—'} | ${s.endedAt ?? '—'} | ${seconds(s.seconds)} | ${s.result} | ${why || '—'} |`);
  }
  if (r.notes?.length) {
    lines.push('', '## 남긴 것', '');
    for (const n of r.notes) lines.push(`- ${n}`);
  }
  lines.push('', '> 이 파일은 `node tools/local/demo.mjs all`이 쓴다. 실패한 실행도 지우지 않는다(계획 B14). 비밀·토큰·쿠키는 싣지 않는다(V-T7 ⑥).', '');
  return redact(lines.join('\n'));
}

/** 측정 파일을 쓴다. 폴더가 없으면 만든다 */
export function writeMeasurement(file, result) {
  mkdirSync(dirname(file), { recursive: true });
  const text = measurementText(result);
  writeFileSync(file, text, 'utf8');
  return { file, bytes: Buffer.byteLength(text) };
}
