import { useEffect, useState, useCallback } from 'react';

// `BeforeInstallPromptEvent` is non-standard; types lib doesn't define it.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/// Captures Chromium's `beforeinstallprompt` event so the dapp can offer an
/// in-UI "Install" button. When `available` is true, calling `install()` shows
/// the native install dialog; the event is consumed after one prompt.
///
/// iOS Safari does NOT fire this event — iPhone users still need to use the
/// share-sheet "Add to Home Screen" flow. The hook just stays inert there.
export function useInstallPrompt() {
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    // matchMedia('(display-mode: standalone)') is true when the app is being
    // viewed as an installed PWA — hide the button in that case.
    return window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  });

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setEvt(null);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!evt) return;
    try {
      await evt.prompt();
      const choice = await evt.userChoice;
      if (choice.outcome === 'accepted') {
        setInstalled(true);
      }
    } finally {
      // The event is single-use; Chrome won't fire it again until the user
      // re-qualifies (visits multiple times, etc.).
      setEvt(null);
    }
  }, [evt]);

  return {
    available: !!evt && !installed,
    installed,
    install,
  };
}
