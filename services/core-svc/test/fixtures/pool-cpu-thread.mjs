// ParsePool 시험용 작업 스레드(BAT-174, S-T34 ④). 진짜 parse-thread처럼 다 실린 뒤 'ready'를 알리고 파일 하나를 받는다.
// 파일 글로 할 일을 고른다: 'busy' = CPU를 쓰는 바쁜 고리(끝나지 않는다), 'sleep:<ms>' = CPU를 거의 쓰지 않고 그만큼 잠든 뒤 답한다, 그 밖 = 곧 답한다.
import { parentPort } from 'node:worker_threads';

const port = parentPort;
if (port) {
  port.once('message', (/** @type {{ file: ArrayBuffer }} */ m) => {
    const text = new TextDecoder().decode(new Uint8Array(m.file));
    if (text === 'busy') {
      let x = 0;
      for (;;) x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    }
    if (text.startsWith('sleep:')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(text.slice(6)));
    port.postMessage({ kind: 'result', status: 'REJECTED', errors: [], ignored: [] });
  });
  port.postMessage({ kind: 'ready' });
}
