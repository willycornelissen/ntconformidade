import type { NtcDesktopApi } from '@ntc/core';

declare global {
  interface Window {
    ntcApi?: NtcDesktopApi;
  }
}

/** Resolves the preload `window.ntcApi` bridge cleanly inside renderer components. */
export function resolveDesktopApi(injected?: NtcDesktopApi): NtcDesktopApi {
  if (injected) {
    return injected;
  }
  if (typeof window !== 'undefined' && window.ntcApi) {
    return window.ntcApi;
  }
  throw new Error('Bridge Electron window.ntcApi indisponível neste ambiente.');
}
