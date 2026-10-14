import { isMobileBrowser, isPublicHost } from './useWallet';

// A relay has to reach BACK to this origin to complete a session, so it can only
// work for an address the outside world can resolve. This began as a guard on the
// metamask.app.link deep link (which opened MetaMask on its home screen and left
// the original tab doing nothing — reported from a phone, 2026-08-02). That
// redirect is gone, replaced by MetaMask Connect, but the constraint is the same
// and now decides whether to warn instead of letting the phone switch to MetaMask
// with nothing to approve.
describe('isPublicHost', () => {
  it.each([
    ['app.satori.example', true],
    ['satori.xyz', true],
  ])('%s -> a relay can reach it: %s', (host, want) => {
    expect(isPublicHost(host)).toBe(want);
  });

  it.each([
    ['my-laptop', 'a bare hostname, which is the tailnet case'],
    ['e26d208de4aa', 'a container hostname'],
    ['100.64.1.2', 'a tailnet IP'],
    ['192.168.1.50', 'a LAN IP'],
    ['127.0.0.1', 'loopback'],
    ['localhost', 'localhost'],
    ['printer.local', 'mDNS'],
    ['', 'nothing at all'],
  ])('%s is NOT public (%s)', (host) => {
    expect(isPublicHost(host)).toBe(false);
  });
});

// `connect` picks one of three paths, and two of them exist because of what
// mobile browsers lack: there is no injected `window.ethereum` in ordinary Chrome
// or Safari on a phone, only inside a wallet app's own browser. Getting this
// wrong on a phone means "no wallet detected" and a dead end, which is exactly
// what a real user hit on 2026-08-02.
describe('isMobileBrowser', () => {
  const MOBILE = {
    'Android Chrome': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    'iPhone Safari': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'iPad Safari': 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Android Firefox': 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
    'MetaMask in-app (Android)': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 MetaMaskMobile',
  };

  const DESKTOP = {
    'macOS Chrome': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Windows Chrome': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Linux Firefox': 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'macOS Safari': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  };

  for (const [name, ua] of Object.entries(MOBILE)) {
    it(`treats ${name} as mobile`, () => expect(isMobileBrowser(ua)).toBe(true));
  }

  for (const [name, ua] of Object.entries(DESKTOP)) {
    // A false positive here would route a desktop user down a mobile path
    // instead of using the extension sitting right there.
    it(`does NOT treat ${name} as mobile`, () => expect(isMobileBrowser(ua)).toBe(false));
  }

  it('does not throw on a missing or empty user agent', () => {
    expect(isMobileBrowser('')).toBe(false);
  });
});
