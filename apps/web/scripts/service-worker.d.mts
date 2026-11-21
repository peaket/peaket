export const SW_DIR: string;
export const SW_FILES: string[];
export const WALLET_CACHE_VERSION_DEFINE: '__WALLET_CACHE_VERSION__';
export function swRevision(env?: Record<string, string | undefined>): string;
export function serwistOptions(env?: Record<string, string | undefined>): {
  swSrc: string;
  useNativeEsbuild: boolean;
  additionalPrecacheEntries: { url: string; revision: string }[];
  esbuildOptions: { define: Record<string, string> };
};
export function stripSourceMapLink(text: string): string;
export function writeServiceWorker(o: { distDir: string }): Promise<{ files: number }>;
