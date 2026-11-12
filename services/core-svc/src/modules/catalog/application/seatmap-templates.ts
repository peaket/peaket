// 유스케이스: 좌석맵 템플릿 목록·하나·템플릿에서 만들기(openapi getPartnerSeatmapTemplates·getPartnerSeatmapTemplate·createPartnerProductionSeatmap, ADR-0066, ADR-0264 결정 17).
// 템플릿은 정적 파일이고, 만들기는 저장과 같은 공연 행 잠금·판 예약·잠금 검사를 그대로 쓴다(SeatmapLayouts.save).
import { Inject, Injectable } from '@nestjs/common';
import { layoutEtag, type SeatMapLayoutView } from '../domain/seatmap-layout.js';
import { type TemplateCatalog, type TemplateSummary, summaryOf, templateLayout, variantProblem } from '../domain/seatmap-templates.js';
import { SEATMAP_LAYOUT_STORE, type SeatmapLayoutStore } from '../domain/seatmap-ports.js';
import { notFound, seatmapInvalid, seatmapReplaceRequired } from './problems.js';
import { type Caller } from './import-seatmap.js';
import { SeatmapLayouts } from './seatmap-layouts.js';

export const SEATMAP_TEMPLATES = Symbol('SEATMAP_TEMPLATES');

export interface CreateFromTemplate {
  productionId: string;
  who: Caller;
  role: string;
  templateId: string;
  targetCapacity: number;
  variant?: Record<string, unknown>;
  replace: boolean;
}

@Injectable()
export class SeatmapTemplates {
  constructor(
    @Inject(SEATMAP_TEMPLATES) private readonly catalog: TemplateCatalog,
    @Inject(SEATMAP_LAYOUT_STORE) private readonly store: SeatmapLayoutStore,
    private readonly layouts: SeatmapLayouts,
  ) {}

  list(): { items: TemplateSummary[] } {
    return { items: this.catalog.list() };
  }

  get(templateId: string): TemplateSummary & { layout: unknown } {
    const t = this.catalog.get(templateId);
    if (!t) throw notFound();
    const layout = templateLayout(t, t.defaultCapacity);
    if (!layout) throw notFound();
    return { ...summaryOf(t), layout };
  }

  async create(q: CreateFromTemplate): Promise<SeatMapLayoutView> {
    const t = this.catalog.get(q.templateId);
    if (!t) throw notFound();
    const bad = variantProblem(t, q.variant);
    if (bad) throw seatmapInvalid([{ line: 0, field: `variant.${bad.split(':')[1] ?? ''}`, code: bad.split(':')[0]! }]);
    const body = templateLayout(t, q.targetCapacity);
    if (!body) throw seatmapInvalid([{ line: 0, field: 'targetCapacity', code: 'TARGET_TOO_SMALL' }]);
    const cur = await this.store.current(q.productionId, q.who.tenantId);
    if (cur === 'not-found') throw notFound();
    const existing = cur?.doc.sections.reduce((n, s) => n + s.seats.length, 0) ?? 0;
    if (existing > 0 && !q.replace) throw seatmapReplaceRequired(existing);
    body.layoutVersion = cur?.version ?? 0;
    return this.layouts.save({
      productionId: q.productionId,
      who: q.who,
      role: q.role,
      ifMatch: layoutEtag(cur?.version ?? 0),
      body,
    });
  }
}
