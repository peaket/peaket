// 좌석맵 템플릿 넣기 CLI: PEAKET_DATABASE_URL·PEAKET_SEATMAP_TEMPLATE_DIR(선택)을 읽어 DB의 TEMPLATE 행을 덮는다.
// 실행: node dist/seed/seatmap-templates.cli.js (배포 때 한 번, ADR-0066)
import { createDatabase } from '@peaket/platform';
import { fileURLToPath } from 'node:url';
import { StaticTemplateCatalog } from '../modules/catalog/adapters/static-template-catalog.js';
import { seedSeatmapTemplates } from './seatmap-templates.js';

const url = process.env.PEAKET_DATABASE_URL;
if (!url) throw new Error('PEAKET_DATABASE_URL이 없다');
const dir = process.env.PEAKET_SEATMAP_TEMPLATE_DIR ?? fileURLToPath(new URL('../../seed/seatmap-templates/', import.meta.url));
const db = createDatabase({ url, applicationName: 'core-svc-seed-templates' });
try {
  const n = await seedSeatmapTemplates(db, StaticTemplateCatalog.load(dir));
  console.log(`좌석맵 템플릿 ${n}종을 넣었다`);
} finally {
  await db.close();
}
