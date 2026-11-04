// 서비스 시작. 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// (OTel SDK가 node:http보다 먼저 서야 한다, docs/devops.md §4.4)
import { createDatabase, createService } from '@peaket/platform';
import { AppModule } from './app.module.js';

const SERVICE = 'core-svc';
const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다(비밀 관리에서 넣는다)');

const database = createDatabase({ url, applicationName: SERVICE });
const service = await createService({ name: SERVICE, module: AppModule.register({ database }) });
await service.listen();
