// scripts/generate.mjs의 형(시험이 가져온다)
export const OPENAPI: string;
export const GEN: string;
export function operationsOf(spec: unknown): Record<string, Record<string, unknown>>;
export function generateAll(root: string, options?: { openapi?: string }): Promise<void>;
