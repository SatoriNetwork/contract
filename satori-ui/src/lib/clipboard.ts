/// Copy text to the clipboard, everywhere the dapp actually runs.
///
/// Extracted from InviteLinkCard, which had the only correct implementation and
/// now calls this instead. The fallback is not defensive padding — it is the
/// difference between working and not on two real surfaces:
///
///  - `navigator.clipboard` exists ONLY in a secure context. Over plain http on
///    a LAN or Tailscale host it is `undefined` and the modern call throws.
///  - Some in-app browsers ship the API but reject the write.
///
/// The legacy `execCommand` path still works in both, so it is tried whenever
/// the modern one does not succeed.
///
/// Returns whether the copy actually happened, so a caller can avoid showing a
/// "Copied" confirmation for something that silently failed — which is worse
/// than no feedback, because the user walks away believing they have the value.
export async function copyText(text: string): Promise<boolean> {
  if (!text || typeof document === 'undefined') return false;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Off-screen but focusable. `display:none` or `visibility:hidden` would
    // make the selection — and therefore the copy — fail silently.
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
