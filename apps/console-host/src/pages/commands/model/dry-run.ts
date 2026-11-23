// dry-run 응답(openapi CommandDryRun 판 1) → 화면 줄(F-03-4 T1, C-T6 ②).
// control-tower §4 dry-run 두 갈래: 센 값은 원천·센 시각과 함께, 예측 값은 식·넣은 값·가정과 함께 보인다.
// 세지 못한 값은 unavailable에만 있고 값 칸이 없다(0으로 바꾸지 않는다, openapi 설명).

export interface RawDryRun {
  version?: number;
  approvalMode?: 'NONE' | 'ONE' | 'TWO' | (string & {});
  reauthRequired?: boolean;
  counted?: readonly { key?: string; value?: number; source?: string; measuredAt?: string }[];
  predicted?: readonly { key?: string; value?: number; formula?: string; inputs?: Record<string, number>; assumptions?: readonly string[] }[];
  unavailable?: readonly { key?: string; source?: string; reason?: string }[];
  limits?: Record<string, number>;
}

export interface DryRunView {
  approval: 'none' | 'one' | 'two';
  reauth: boolean;
  counted: { key: string; value: number; source: string; measuredAt: string }[];
  predicted: { key: string; value: number; formula: string; inputs: [string, number][]; assumptions: string[] }[];
  unavailable: { key: string; source: string; reason: string }[];
  limits: [string, number][];
}

const APPROVAL: Record<string, DryRunView['approval']> = { NONE: 'none', ONE: 'one', TWO: 'two' };

export function dryRunView(raw: RawDryRun): DryRunView {
  return {
    // 모르는 값은 더 엄한 쪽(2인)으로 본다
    approval: APPROVAL[raw.approvalMode ?? ''] ?? 'two',
    reauth: raw.reauthRequired === true,
    counted: (raw.counted ?? []).map((c) => ({ key: String(c.key ?? ''), value: Number(c.value), source: String(c.source ?? ''), measuredAt: String(c.measuredAt ?? '') })),
    predicted: (raw.predicted ?? []).map((p) => ({
      key: String(p.key ?? ''),
      value: Number(p.value),
      formula: String(p.formula ?? ''),
      inputs: Object.entries(p.inputs ?? {}).map(([k, v]) => [k, Number(v)] as [string, number]),
      assumptions: [...(p.assumptions ?? [])].map(String),
    })),
    unavailable: (raw.unavailable ?? []).map((u) => ({ key: String(u.key ?? ''), source: String(u.source ?? ''), reason: String(u.reason ?? '') })),
    limits: Object.entries(raw.limits ?? {}).map(([k, v]) => [k, Number(v)] as [string, number]),
  };
}
