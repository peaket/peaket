// 템플릿 고르기 카드 목업: entities의 템플릿 10종(d5 §6.5 표)에 보드 SCR-022 카드의 구역 수를 덮어쓴다(보드가 정본 표보다 우선).
import type { TemplateCardData } from '@peaket/ds/TemplatePicker';
import { TEMPLATE_FAMILIES, seatmapTemplates } from '@/entities/seatmap';

/** 보드 카드에 적힌 구역 수(entities 값과 다른 것이 있다: 돌출 무대 24·센터 무대 32·돔 44·종합운동장 36·대극장 12·콘서트홀 11) */
const BOARD_ZONES: Record<string, number> = {
  'ARENA-END': 24,
  'ARENA-THRUST': 24,
  'ARENA-CENTER': 32,
  DOME: 44,
  STADIUM: 36,
  'THEATER-L': 12,
  'THEATER-M': 6,
  'THEATER-S': 2,
  HALL: 11,
  FLAT: 12,
};

export const TEMPLATE_CARDS: readonly TemplateCardData[] = seatmapTemplates.map((t) => ({
  code: t.code,
  name: t.name,
  family: t.family,
  defaultCapacity: t.defaultCapacity,
  floors: t.floors,
  zones: BOARD_ZONES[t.code] ?? t.zones,
  composition: t.composition,
}));

export const TEMPLATE_FAMILY_CHIPS: readonly string[] = TEMPLATE_FAMILIES;
