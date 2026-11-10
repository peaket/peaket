// 측정 무대의 회차 시작 파일(BUILD_ORDER PRF-215): 합본 파드 안에서 실행 도구가 부른다(내용은 seed.ts).
//   node dist/seed-cli.js open '<JSON>'   회차 열기(일정 사본·회차 목록·좌석 판매·다시 만들기 표시)
//   node dist/seed-cli.js close <eventId> 회차 끝내기(입장 제어 회차 목록·좌석 판매 목록에서 뺀다, 코드 리뷰 H1)
//   node dist/seed-cli.js active          진행 중인 회차 목록(점수(공연 시작 시각)가 지금보다 뒤인 것)
// PEAKET_ENV가 local·ci가 아니면 아무것도 쓰지 않고 종료 코드 2로 끝낸다. 결과는 표준 출력 한 줄 JSON이다(키·주소를 싣지 않는다).
import { BUNDLE_ENVS } from './bundle.js';
import { activeEvents, closeEvent, parseSeedRequest, seed, type SeedRequest } from './seed.js';

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
const env = process.env.PEAKET_ENV ?? '';
if (!(BUNDLE_ENVS as readonly string[]).includes(env)) fail(`시드는 PEAKET_ENV ${BUNDLE_ENVS.join('·')}에서만 쓴다(지금 '${env}')`);
const envDir = process.env.PEAKET_BUNDLE_ENV_DIR || fail('PEAKET_BUNDLE_ENV_DIR가 없다');
const [command, arg] = process.argv.slice(2);
if (command === 'open') {
  let request: SeedRequest | undefined;
  try {
    request = parseSeedRequest(JSON.parse(arg ?? ''));
  } catch (err) {
    fail(`시드 요청이 틀렸다: ${(err as Error).message}`);
  }
  console.log(JSON.stringify(await seed(request!, { envDir })));
} else if (command === 'close') {
  console.log(JSON.stringify(await closeEvent(arg ?? '', { envDir })));
} else if (command === 'active') {
  console.log(JSON.stringify(await activeEvents(Date.now(), { envDir })));
} else {
  fail('쓰는 법: seed-cli.js open <JSON> | close <eventId> | active');
}
