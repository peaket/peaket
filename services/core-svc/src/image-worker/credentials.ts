// F-10-2 image-worker가 받으면 안 되는 자격 증명(계획 docs/review/plans/F-10-2.md §3·§5, D-T35 ①, ASVS v5.0.0-15.2.5).
// DB·Kafka·Redis 이름이 하나라도 있으면(빈 값도) 뜨지 않는다. AWS S3 자격 증명은 이 작업이 S3만 쓰므로 허용한다.
const FORBIDDEN = /DATABASE_URL|KAFKA|REDIS/i;

export function forbiddenCredentialNames(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && FORBIDDEN.test(k))
    .sort();
}
