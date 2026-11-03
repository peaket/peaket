// 시뮬레이터 실행 파일. 설정은 환경 값으로만 받는다(키가 명령줄·로그에 보이지 않게).
import { loadSimulatorConfig } from './config.js';
import { buildSimulatorApp } from './server.js';

const config = loadSimulatorConfig(process.env);
const app = buildSimulatorApp({ secretKey: config.secretKey, seed: config.seed, confirmLatency: config.confirmLatency });
const address = await app.listen({ host: config.host, port: config.port });
process.stdout.write(`pg-simulator listening ${address}\n`);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
