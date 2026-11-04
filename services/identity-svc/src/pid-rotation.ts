// pid 키 전환 작업(docs/features/identity.md §5 'pid 키 전환의 첫 구현', BUILD_ORDER BOT-025, docs/security/secrets-and-keys.md pid 행).
// 서비스와 같은 이미지를 다른 시작 명령으로 한 번 띄운다(쿠버네티스 Job): node dist/pid-rotation.js start --until <ISO 8601 시각> | finish | status
// DB 주소와 pid 키 설정(PEAKET_PID_HMAC_KMS_KEY·PEAKET_PID_HMAC_KEY_VERSION, local·ci·demo는 설정값 키)은 서비스와 같은 값을 읽는다.
// 결과는 한 줄 JSON으로 표준 출력에 쓴다(키·pid 값은 쓰지 않는다). 업무 거절은 1, 명령 줄이 틀리면 2로 끝난다.
import { createDatabase, systemClock } from '@peaket/platform';
import { DrizzleVerificationStore, HmacIdentityHashers, KmsIdentityHashers, parsePidRotationArgs, PidRotation, PidRotationError } from './modules/verification/index.js';

let cmd: ReturnType<typeof parsePidRotationArgs>;
try {
  cmd = parsePidRotationArgs(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(2);
}

const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');
const hashers = KmsIdentityHashers.fromEnv(process.env) ?? HmacIdentityHashers.fromEnv(process.env);
const database = createDatabase({ url, applicationName: 'identity-svc-pid-rotation', max: 2 });
const rotation = new PidRotation(new DrizzleVerificationStore(database), hashers, systemClock);
const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

try {
  if (cmd.command === 'start') {
    const r = await rotation.start(cmd.until === undefined ? {} : { until: cmd.until });
    process.stdout.write(`${JSON.stringify({ command: 'start', ...r, transitionEndsAt: iso(r.transitionEndsAt), movedAt: iso(r.movedAt), safeToOpenAt: iso(r.safeToOpenAt) })}\n`);
  } else if (cmd.command === 'finish') {
    process.stdout.write(`${JSON.stringify({ command: 'finish', ...(await rotation.finish()) })}\n`);
  } else {
    const s = await rotation.status();
    const open = s.open && { ...s.open, startedAt: iso(s.open.startedAt), transitionEndsAt: iso(s.open.transitionEndsAt), movedAt: iso(s.open.movedAt) };
    process.stdout.write(`${JSON.stringify({ command: 'status', ...s, open, safeToOpenAt: iso(s.safeToOpenAt) })}\n`);
  }
} catch (e) {
  if (!(e instanceof PidRotationError)) throw e;
  process.stderr.write(`${JSON.stringify({ command: cmd.command, error: e.code, message: e.message, moved: e.moved, remaining: e.remaining })}\n`);
  process.exitCode = 1;
} finally {
  await database.close();
}
