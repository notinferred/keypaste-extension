import { test, expect } from '@playwright/test';
import {
    continuesOn,
    elementsOverlap,
    fillFor,
    frameRequest,
    matchesWithNodeName,
    siteMatch
} from '../src/common/global.js';

test('Test matchesWithNodeName()', async ({ page }) => {
    const elem1 = { nodeName: 'INPUT' };
    const elem2 = { nodeName: 'input' };
    expect(matchesWithNodeName(elem1, 'INPUT')).toBe(true);
    expect(matchesWithNodeName(elem1, 'input')).toBe(true);
    expect(matchesWithNodeName(elem2, 'INPUT')).toBe(true);
    expect(matchesWithNodeName(elem2, 'input')).toBe(true);
    expect(matchesWithNodeName(elem1, 'TEXT')).toBe(false);
    expect(matchesWithNodeName(elem1, 'text')).toBe(false);
    expect(matchesWithNodeName(undefined, 'INPUT')).toBe(false);
    expect(matchesWithNodeName(undefined, undefined)).toBe(false);
});

test('Test siteMatch()', async ({ page }) => {
    expect(siteMatch('https://example.com/*', 'https://example.com/login_page')).toBe(true);
    expect(siteMatch('https://*.lexample.com/*', 'https://example.com/login_page')).toBe(false);
    expect(siteMatch('https://example.com/*', 'https://example2.com/login_page')).toBe(false);
    expect(siteMatch('https://example.com/*', 'https://subdomain.example.com/login_page')).toBe(false);
    expect(siteMatch('https://example.com', 'https://subdomain.example.com/login_page')).toBe(false);
    expect(siteMatch('https://*.example.com/*', 'https://example.com/login_page')).toBe(true);
    expect(siteMatch('https://*.example.com/*', 'https://test.example.com/login_page')).toBe(true);
    expect(siteMatch('https://test.example.com/*', 'https://subdomain.example.com/login_page')).toBe(false);
    expect(siteMatch('https://test.example.com/page/*', 'https://test.example.com/page/login_page')).toBe(true);
    expect(siteMatch('https://test.example.com/page/*', 'https://test.example.com/page/login_page?dontcare=aboutme')).toBe(true);
    expect(siteMatch('https://test.example.com/page/another_page/*', 'https://test.example.com/page/login')).toBe(false);
    expect(siteMatch('https://test.example.com/path/another/a/', 'https://test.example.com/path/another/a/')).toBe(true);
    expect(siteMatch('https://test.example.com/path/another/a/', 'https://test.example.com/path/another/b/')).toBe(false);
    expect(siteMatch('https://test.example.com/*/another/a/', 'https://test.example.com/path/another/a/')).toBe(true);
    expect(siteMatch('https://test.example.com/path/*/a/', 'https://test.example.com/path/another/a/')).toBe(true);
    expect(siteMatch('https://test.example.com/path2/*/a/', 'https://test.example.com/path/another/a/')).toBe(false);
    expect(siteMatch('https://example.com:8448/', 'https://example.com/')).toBe(false);
    expect(siteMatch('https://example.com:8448/', 'https://example.com:8448/')).toBe(true);
    expect(siteMatch('https://example.com:8448/login/page', 'https://example.com/login/page')).toBe(false);
    expect(siteMatch('https://example.com:8448/*', 'https://example.com:8448/login/page')).toBe(true);
    expect(siteMatch('https://example.com/$/*', 'https://example.com/$/login_page')).toBe(true); // Special character in URL
    expect(siteMatch('https://example.com/*/*', 'https://example.com/$/login_page')).toBe(true);
    expect(siteMatch('https://example.com/*/*', 'https://example.com/login_page')).toBe(false);
    expect(siteMatch('https://*.com/*', 'https://example.com/$/login_page')).toBe(true);
    expect(siteMatch('https://*.com/*', 'https://example.org/$/login_page')).toBe(false);
    expect(siteMatch('https://*.*/*', 'https://example.org/$/login_page')).toBe(true);

    // IP based URL's
    expect(siteMatch('https://127.128.129.130:8448/', 'https://127.128.129.130:8448/')).toBe(true);
    expect(siteMatch('https://127.128.129.*:8448/', 'https://127.128.129.130:8448/')).toBe(true);
    expect(siteMatch('https://127.128.*/', 'https://127.128.129.130/')).toBe(true);
    expect(siteMatch('https://127.128.*/', 'https://127.1.129.130/')).toBe(false);
    expect(siteMatch('https://127.128.129.130/', 'https://127.128.129.130:8448/')).toBe(true);
    expect(siteMatch('https://127.128.129.*/', 'https://127.128.129.130:8448/')).toBe(true);

    // Invalid URL's
    expect(siteMatch('', 'https://example.com')).toBe(false);
    expect(siteMatch('abcdefgetc', 'https://example.com')).toBe(false);
    expect(siteMatch('{TOTP}\\no', 'https://example.com')).toBe(false);
    expect(siteMatch('https://320.320.320.320', 'https://example.com')).toBe(false);
});

// Check if different popups/overlays partially covers or touches the input field
test('Test elementsOverlap()', async ({ page }) => {
    const inputRect = { left: 0, top: 5, right: 200, bottom: 28 }

    // Fully covered
    expect(elementsOverlap(inputRect, { left: -2, top: 0, right: 220, bottom: 40 })).toBe(true);

    // Top side is covered
    expect(elementsOverlap(inputRect, { left: 0, top: 0, right: 220, bottom: 20 })).toBe(true);

    // Bottom side is covered
    expect(elementsOverlap(inputRect, { left: -2, top: 25, right: 220, bottom: 40 })).toBe(true);

    // Left side is covered
    expect(elementsOverlap(inputRect, { left: -2, top: 0, right: 100, bottom: 40 })).toBe(true);

    // Right side is covered
    expect(elementsOverlap(inputRect, { left: 100, top: 0, right: 220, bottom: 40 })).toBe(true);

    // Top-left corner is covered
    expect(elementsOverlap(inputRect, { left: -2, top: 0, right: 40, bottom: 10 })).toBe(true);

    // Top-right corner is covered
    expect(elementsOverlap(inputRect, { left: 180, top: 0, right: 220, bottom: 10 })).toBe(true);

    // Bottom-left corner is covered
    expect(elementsOverlap(inputRect, { left: -2, top: 10, right: 100, bottom: 40 })).toBe(true);

    // Bottom-right corner is covered
    expect(elementsOverlap(inputRect, { left: 180, top: 10, right: 220, bottom: 40 })).toBe(true);

    // Input field is covered with identical size
    expect(elementsOverlap(inputRect, { left: 0, top: 5, right: 200, bottom: 28 })).toBe(true);

    // Overlay is inside the input field
    expect(elementsOverlap(inputRect, { left: 2, top: 10, right: 180, bottom: 26 })).toBe(true);

     // Overlay is partially inside the input field, comes outside from the left
    expect(elementsOverlap(inputRect, { left: -2, top: 10, right: 180, bottom: 26 })).toBe(true);

    // Overlay is outside the input field
    expect(elementsOverlap(inputRect, { left: 210, top: 0, right: 240, bottom: 40 })).toBe(false);
});


test('Test fillFor()', async () => {
    expect(fillFor(true, false)).toBe('username');
    expect(fillFor(false, true)).toBe('password');
    expect(fillFor(true, true)).toBe('both');
    // A form whose fields keypaste can't see, as the toolbar popup's pick, asks for both as 1.0.0 did
    expect(fillFor(false, false)).toBe('both');
});

test('Test frameRequest()', async () => {
    const all = [ 'fill', 'continued', 'frames', 'totp' ];
    const tab = 'https://www.icloud.com/';
    const frame = 'https://idmsa.apple.com/appleauth/auth/authorize/signin?frame_id=1';

    // The tab's own document and a frame of its origin ask with the tab's address
    expect(frameRequest(tab, tab, 'https://www.icloud.com', all)).toEqual({ url: tab });
    expect(frameRequest(tab, 'https://www.icloud.com/frame', 'https://www.icloud.com', [])).toEqual({ url: tab });
    expect(frameRequest(tab, '', '', [])).toEqual({ url: tab });

    // A frame of another origin asks with its own address and the tab's, only when keypaste decides frames
    expect(frameRequest(tab, frame, 'https://idmsa.apple.com', all)).toEqual({ url: frame, topUrl: tab });
    expect(frameRequest(tab, frame, '', all)).toEqual({ url: frame, topUrl: tab });
    expect(frameRequest(tab, frame, 'https://idmsa.apple.com', [ 'fill', 'continued' ])).toBe(null);
    expect(frameRequest(tab, frame, 'https://idmsa.apple.com', [])).toBe(null);

    // Sandboxed and http frames are never asked about, even of the tab's own address
    expect(frameRequest(tab, frame, 'null', all)).toBe(null);
    expect(frameRequest(tab, tab, 'null', all)).toBe(null);
    expect(frameRequest(tab, 'http://login.example.test/', 'http://login.example.test', all)).toBe(null);
    expect(frameRequest(tab, 'about:blank', 'null', all)).toBe(null);

    // No tab address, no request
    expect(frameRequest(undefined, frame, 'https://idmsa.apple.com', all)).toBe(null);
    expect(frameRequest('about:blank', frame, 'https://idmsa.apple.com', all)).toBe(null);
});

test('Test continuesOn()', async () => {
    expect(continuesOn('accounts.google.com', 'google.com')).toBe(true);
    expect(continuesOn('google.com', 'google.com')).toBe(true);
    expect(continuesOn('Login.Example.co.uk', 'example.co.uk')).toBe(true);
    expect(continuesOn('notgoogle.com', 'google.com')).toBe(false);
    expect(continuesOn('google.com.evil.test', 'google.com')).toBe(false);
    expect(continuesOn('google.com', '')).toBe(false);
    expect(continuesOn('', 'google.com')).toBe(false);
});
