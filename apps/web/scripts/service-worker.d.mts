export const SW_DIR: string;
export const SW_FILES: string[];
export function swRevision(env?: Record<string, string | undefined>): string;
export function serwistOptions(env?: Record<string, string | undefined>): {
  swSrc: string;
  useNativeEsbuild: boolean;
  additionalPrecacheEntries: { url: string; revision: string }[];
};
export function stripSourceMapLink(text: string): string;
export function writeServiceWorker(o: { distDir: string }): Promise<{ files: number }>;
