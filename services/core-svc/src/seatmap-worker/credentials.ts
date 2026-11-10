// seatmap-worker가 받으면 안 되는 자격 증명 환경 값(ADR-0257 결정 5, docs/security/asvs/seat-hold.md 15.2.5, S-T34 ①의 코드 몫).
// 이 작업은 위험한 해석(XML 읽기)을 하므로 DB·Kafka·Redis·AWS 자격 증명이 하나라도 들어오면 뜨지 않는다. 배포 상태의 확인은 BAS-140·HOT-420이다.
// 이름에 DATABASE_URL·REDIS·KAFKA·SECRET·PASSWORD·PEPPER·HMAC·TOKEN이 들었거나 _KEY·_KEYS로 끝나거나 AWS_·PG로 시작하면 자격 증명으로 본다(대소문자 무시)
const FORBIDDEN = [/DATABASE_URL|REDIS|KAFKA|SECRET|PASSWORD|PEPPER|HMAC|TOKEN/i, /_KEYS?$/i, /^AWS_/i, /^PG/i];

/** 들어온 금지 이름(값은 돌려주지 않는다). 빈 값이라도 이름이 있으면 센다 */
export function forbiddenCredentialNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && FORBIDDEN.some((re) => re.test(k)))
    .sort();
}
