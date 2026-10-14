/// Farcaster Mini App support: one call, and the reason it has to happen.
///
/// A Farcaster client shows a splash screen over an embedded app and only
/// removes it when the app calls `sdk.actions.ready()`. Skip the call and the
/// app loads perfectly behind a splash the user never gets past, which is the
/// single most common way a Mini App ships broken.
///
/// This is FARCASTER ONLY. The Base App retired the Mini App spec on
/// 2026-04-09 and is now a plain in-app browser, so none of this runs there.
/// See docs/issues/base-app-integration.md.
///
/// Two properties this file exists to guarantee:
///
///  1. **Ordinary browsers pay nothing.** The SDK is behind a dynamic import
///     that only runs when the page is embedded, so it is a separate chunk that
///     is never fetched by someone opening the dapp in a normal tab.
///  2. **It can never break the dapp.** Every failure is swallowed. Being
///     unable to talk to a Farcaster client is not a reason for Satori to fail
///     to load, and outside a Farcaster client every call here is expected to
///     be unavailable.

/// The two calls we make, declared locally rather than imported.
///
/// `@farcaster/miniapp-sdk@0.3.0` ships declarations that import each other
/// with explicit `.ts` extensions (`export * from './sdk.ts'`). That resolves
/// only under TypeScript 5's bundler/node16 resolution; this app is CRA 5 on
/// TypeScript 4.9 with classic node resolution, so the named exports come back
/// as missing and the build fails. Upgrading the compiler for the whole dapp to
/// satisfy one optional dependency is the wrong trade, so the surface we
/// actually touch is two methods, written out here.
///
/// The cast is contained: if the SDK ever changes these signatures, this file
/// is the one place that has to notice.
type MiniAppSdk = {
  isInMiniApp: () => Promise<boolean>;
  actions: { ready: () => Promise<void> };
};

/// Cheap pre-check before importing anything: a Mini App is always embedded,
/// either in an iframe (web clients) or a webview (mobile). A top-level page
/// cannot be one, so this is a sound early exit rather than a guess.
function looksEmbedded(): boolean {
  try {
    return window.parent !== window || Boolean((window as any).ReactNativeWebView);
  } catch {
    // A cross-origin parent can throw on access, which itself means embedded.
    return true;
  }
}

/// Dismiss the Farcaster splash screen once the app has rendered. Safe to call
/// anywhere, on any platform: outside a Farcaster client it returns having done
/// nothing.
export async function signalReadyToFarcaster(): Promise<void> {
  if (typeof window === 'undefined' || !looksEmbedded()) return;
  try {
    // Named and default both carry the same object at runtime; take whichever
    // is present so a packaging change on their side cannot break this.
    const mod = (await import('@farcaster/miniapp-sdk')) as unknown as {
      sdk?: MiniAppSdk;
      default?: MiniAppSdk;
    };
    const sdk = mod.sdk ?? mod.default;
    if (!sdk) return;

    if (await sdk.isInMiniApp()) {
      await sdk.actions.ready();
    }
  } catch {
    // Not a Farcaster client, SDK chunk unreachable, or the host rejected the
    // call. None of those are Satori's problem and none should surface.
  }
}
