// 좌석맵 템플릿 10종을 DB의 TEMPLATE 행으로 넣는다(배포 때 한 번, ADR-0066).
// 정적 JSON 파일이 정본이고 DB 행은 templateOk·templateDraft가 읽는 사본이다. 여러 번 돌려도 같은 값으로 덮는다.
import { and, eq } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import { section, venue } from '../modules/catalog/adapters/db/schema.js';
import { StaticTemplateCatalog } from '../modules/catalog/adapters/static-template-catalog.js';

export async function seedSeatmapTemplates(db: Database, catalog: StaticTemplateCatalog): Promise<number> {
  const defs = catalog.definitions();
  await db.transaction(async (tx) => {
    for (const t of defs) {
      await tx
        .insert(venue)
        .values({
          id: t.templateId,
          name: t.name,
          kind: 'TEMPLATE',
          canvasWidth: t.canvas.width,
          canvasHeight: t.canvas.height,
          stageShapes: t.stage,
          layoutVersion: 0,
          versionSeq: 0,
          published: true,
        })
        .onConflictDoUpdate({
          target: venue.id,
          set: {
            name: t.name,
            kind: 'TEMPLATE',
            canvasWidth: t.canvas.width,
            canvasHeight: t.canvas.height,
            stageShapes: t.stage,
            published: true,
          },
        });
      await tx.delete(section).where(and(eq(section.venueId, t.templateId)));
      await tx.insert(section).values(
        t.sections.map((s, i) => ({
          venueId: t.templateId,
          sectionKey: s.sectionId,
          sortOrder: i,
          name: s.name,
          ...(s.level !== undefined ? { level: s.level } : {}),
          shape: s.shape.points,
          editorMeta: { tool: s.shape.kind, fillRule: s.fillRule, ...(s.shape.name !== undefined ? { shapeName: s.shape.name } : {}) },
          ...(s.tierId !== undefined ? { defaultTier: s.tierId } : {}),
        })),
      );
    }
  });
  return defs.length;
}
