import { describe, expect, it } from 'vitest';

import { DEFAULT_NEXT, safeNext } from './redirect';

const ORIGIN = 'https://tsugu.example';

/** What the guard replaced by `safeNext` used to do, kept as a regression oracle. */
function legacyGuard(raw: string): string {
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

describe('safeNext — paths that must survive', () => {
  it('keeps ordinary same-origin paths', () => {
    expect(safeNext('/', ORIGIN)).toBe('/');
    expect(safeNext('/inventory', ORIGIN)).toBe('/inventory');
    expect(safeNext('/cooking/session/abc', ORIGIN)).toBe('/cooking/session/abc');
  });

  it('keeps the query string', () => {
    expect(safeNext('/inventory?filter=expiring', ORIGIN)).toBe('/inventory?filter=expiring');
    expect(safeNext('/inventory?a=1&b=2', ORIGIN)).toBe('/inventory?a=1&b=2');
  });

  it('keeps the fragment', () => {
    expect(safeNext('/settings#notifications', ORIGIN)).toBe('/settings#notifications');
  });

  it('keeps percent-encoded segments encoded rather than decoding them into a host', () => {
    expect(safeNext('/%2f%2fevil.example.com', ORIGIN)).toBe('/%2f%2fevil.example.com');
  });

  it('works without an explicit origin, using the built-in probe origin', () => {
    expect(safeNext('/inventory')).toBe('/inventory');
    expect(safeNext('//evil.example.com')).toBe(DEFAULT_NEXT);
  });
});

describe('safeNext — protocol-relative and backslash escapes', () => {
  // Each of these resolves to an origin the attacker controls. The backslash
  // cases are the ones a `startsWith('/')` check waves through.
  const escapes = [
    '//evil.example.com',
    '//evil.example.com/path',
    '/\\evil.example.com',
    '/\\/evil.example.com',
    '/\\\\evil.example.com',
    '//\\evil.example.com',
    '\\\\evil.example.com',
    '\\/evil.example.com',
    '/\\evil.example.com/login?next=/',
  ];

  for (const raw of escapes) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      expect(safeNext(raw, ORIGIN)).toBe(DEFAULT_NEXT);
    });
  }

  it('rejects escapes hidden behind stripped control characters', () => {
    expect(safeNext('\t//evil.example.com', ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext('\n//evil.example.com', ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext(' //evil.example.com', ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext('/\t/evil.example.com', ORIGIN)).toBe(DEFAULT_NEXT);
  });

  it('closes the hole the previous guard left open', () => {
    // The point of the rewrite: the old check called this same-origin.
    expect(legacyGuard('/\\evil.example.com')).toBe('/\\evil.example.com');
    expect(new URL('/\\evil.example.com', ORIGIN).origin).toBe('https://evil.example.com');
    expect(safeNext('/\\evil.example.com', ORIGIN)).toBe(DEFAULT_NEXT);
  });
});

describe('safeNext — absolute URLs', () => {
  it('rejects another origin even when the scheme matches', () => {
    expect(safeNext('https://evil.example.com/', ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext('https://evil.example.com/inventory', ORIGIN)).toBe(DEFAULT_NEXT);
  });

  it('rejects look-alike hosts', () => {
    expect(safeNext('https://tsugu.example.evil.com/', ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext('https://tsugu.example@evil.com/', ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext('https://evil.com#tsugu.example', ORIGIN)).toBe(DEFAULT_NEXT);
  });

  it('rejects the same host on a different scheme or port', () => {
    expect(safeNext('http://tsugu.example/inventory', ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext('https://tsugu.example:8443/inventory', ORIGIN)).toBe(DEFAULT_NEXT);
  });

  it('rejects an absolute URL to our own origin — the input contract is a path', () => {
    expect(safeNext('https://tsugu.example/inventory', ORIGIN)).toBe(DEFAULT_NEXT);
  });
});

describe('safeNext — non-http schemes', () => {
  const schemes = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'mailto:someone@example.com',
  ];

  for (const raw of schemes) {
    it(`rejects ${JSON.stringify(raw)}`, () => {
      expect(safeNext(raw, ORIGIN)).toBe(DEFAULT_NEXT);
    });
  }
});

describe('safeNext — malformed input', () => {
  it('falls back for missing values', () => {
    expect(safeNext(null, ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext(undefined, ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext('', ORIGIN)).toBe(DEFAULT_NEXT);
  });

  it('falls back for values that are not paths', () => {
    expect(safeNext('inventory', ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext('evil.example.com', ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext('../inventory', ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext('?next=/inventory', ORIGIN)).toBe(DEFAULT_NEXT);
    expect(safeNext('#/inventory', ORIGIN)).toBe(DEFAULT_NEXT);
  });

  it('falls back for a broken origin instead of throwing', () => {
    expect(safeNext('/inventory', 'not-a-url')).toBe(DEFAULT_NEXT);
    expect(safeNext('/inventory', '')).toBe(DEFAULT_NEXT);
  });

  it('never returns anything a browser could read as an absolute URL', () => {
    const inputs = [
      '/',
      '/inventory',
      '//evil.example.com',
      '/\\evil.example.com',
      'https://evil.example.com',
      'javascript:alert(1)',
      '../../etc',
      '',
    ];
    for (const raw of inputs) {
      const next = safeNext(raw, ORIGIN);
      expect(next.startsWith('/')).toBe(true);
      expect(next.startsWith('//')).toBe(false);
      expect(new URL(next, ORIGIN).origin).toBe(ORIGIN);
    }
  });
});
