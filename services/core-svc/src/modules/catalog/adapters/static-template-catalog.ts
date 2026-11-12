// 정적 템플릿 파일을 읽는 카탈로그(배포 때 넣는 seed/seatmap-templates/*.json, ADR-0066).
// 파일이 하나라도 모자라거나 모양이 틀리면 시작하지 않는다(템플릿 카드가 조용히 비지 않게).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATE_CODES, type TemplateCatalog, type TemplateDefinition, type TemplateSummary, summaryOf } from '../domain/seatmap-templates.js';

export class StaticTemplateCatalog implements TemplateCatalog {
  readonly #byId = new Map<string, TemplateDefinition>();
  readonly #all: TemplateDefinition[];

  constructor(defs: readonly TemplateDefinition[]) {
    for (const d of defs) {
      if (this.#byId.has(d.templateId)) throw new Error(`템플릿 ID가 겹친다: ${d.templateId}`);
      this.#byId.set(d.templateId, d);
    }
    const codes = new Set(defs.map((d) => d.code));
    if (defs.length !== TEMPLATE_CODES.length || TEMPLATE_CODES.some((c) => !codes.has(c))) throw new Error(`템플릿 10종이 아니다: ${defs.length}종`);
    this.#all = [...defs];
  }

  static load(dir: string): StaticTemplateCatalog {
    const files = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    return new StaticTemplateCatalog(files.map((n) => parseTemplate(readFileSync(join(dir, n), 'utf8'), n)));
  }

  list(): TemplateSummary[] {
    return this.#all.map(summaryOf);
  }

  /** 배포 때 넣는 쪽(seed)이 전체 정의를 읽는다 */
  definitions(): readonly TemplateDefinition[] {
    return this.#all;
  }

  get(templateId: string): TemplateDefinition | undefined {
    return this.#byId.get(templateId);
  }
}

function parseTemplate(text: string, name: string): TemplateDefinition {
  const v = JSON.parse(text) as Partial<TemplateDefinition>;
  const fail = (why: string): never => {
    throw new Error(`템플릿 파일이 틀렸다(${name}): ${why}`);
  };
  if (typeof v.templateId !== 'string' || !/^[0-9a-f-]{36}$/.test(v.templateId)) fail('templateId');
  if (typeof v.code !== 'string' || !(TEMPLATE_CODES as readonly string[]).includes(v.code)) fail('code');
  if (typeof v.name !== 'string' || v.name.length === 0) fail('name');
  if (!v.canvas || !(v.canvas.width > 0) || !(v.canvas.height > 0)) fail('canvas');
  const sections = v.sections ?? [];
  if (!Array.isArray(v.stage) || !Array.isArray(v.sections) || sections.length === 0) fail('stage·sections');
  for (const s of sections) {
    if (typeof s.sectionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(s.sectionId)) fail(`sectionId ${s.sectionId}`);
    if (typeof s.name !== 'string' || s.name.length === 0) fail(`section name ${s.sectionId}`);
    if (!s.shape || !Array.isArray(s.shape.points) || s.shape.points.length < 3) fail(`shape ${s.sectionId}`);
    if (!s.fillRule || typeof s.fillRule !== 'object') fail(`fillRule ${s.sectionId}`);
  }
  return v as TemplateDefinition;
}

/** 템플릿을 넣지 않은 시험·대역: 목록은 비고 만들기는 404다(조용히 틀린 템플릿을 만들지 않는다) */
export class EmptyTemplateCatalog implements TemplateCatalog {
  list(): TemplateSummary[] {
    return [];
  }
  get(): undefined {
    return undefined;
  }
}
