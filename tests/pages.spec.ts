import { test, expect, Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { tileHue, tileLetter } from '../src/common/global.js';

const messages = JSON.parse(fs.readFileSync('src/_locales/en/messages.json', 'utf8'));
const message = (key: string) => messages[key].message;

// The extension's pages over a browser.* that answers each runtime message from answers, sends tabs' messages to tabAnswers.
const stubExtension = async (page: Page, answers: Record<string, unknown>, tabAnswers: Record<string, unknown> = {}, base = pathToFileURL('src/').toString()) => {
    await page.addInitScript(({ messages, answers, tabAnswers, base }) => {
        const getMessage = (key: string, subs?: unknown) => {
            const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [ subs ];
            return (messages[key]?.message ?? '').replace(/\$(\d)/g, (_m: string, n: string) => String(list[Number(n) - 1] ?? ''));
        };
        const sent: string[] = [];
        Object.assign(globalThis, {
            sent,
            chrome: { runtime: { id: 'test' } },
            browser: {
                runtime: {
                    id: 'test',
                    getURL: (path: string) => base + path,
                    getManifest: () => ({ version: '1.0.0' }),
                    sendMessage: (m: { action: string }) => {
                        sent.push(m.action);
                        const answer = answers[m.action];
                        return answer === 'pending' ? new Promise(() => {}) : Promise.resolve(answer);
                    },
                    openOptionsPage: () => Promise.resolve(),
                    onMessage: { addListener: () => {} },
                },
                i18n: { getMessage, getUILanguage: () => 'en' },
                tabs: {
                    query: () => Promise.resolve([ { id: 1, url: 'https://github.com/login' } ]),
                    sendMessage: (_id: number, m: { action: string }) => Promise.resolve(tabAnswers[m.action]),
                },
                webNavigation: { getAllFrames: () => Promise.resolve([ { frameId: 0 }, { frameId: 3 } ]) },
                storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
            },
        });
    }, { messages, answers, tabAnswers, base });
};

const STATUS = (status = {}) => ({
    keypasteAvailable: true, configured: true, associated: true, databaseClosed: false, encryptionKeyUnrecognized: false,
    error: undefined, iframeDetected: false, identifier: 'Chrome on MacBook Pro', ...status,
});

const openPopup = async (page: Page, answers: Record<string, unknown>, tabAnswers = {}) => {
    await stubExtension(page, answers, tabAnswers);
    await page.goto(pathToFileURL('src/popups/popup.html').toString());
};

test('A login takes one of seven tile hues, the same every time, and its title\'s first letter or digit', () => {
    const uuid = '0123456789abcdef0123456789abcdef';
    expect(tileHue(uuid)).toBe(tileHue(uuid.toUpperCase()));
    const hues = new Set(Array.from({ length: 50 }, (_, i) => tileHue(i.toString(16).padStart(32, '0'))));
    expect([ ...hues ].every(hue => hue >= 1 && hue <= 7)).toBe(true);
    expect(hues.size).toBe(7);
    expect(tileLetter('  github.com')).toBe('G');
    expect(tileLetter('(old) 2fa')).toBe('O');
    expect(tileLetter('…')).toBe('?');
});

test('The popup heads each state with its name and shows only that state', async ({ page }) => {
    await openPopup(page, { get_status: STATUS() });
    await expect(page.locator('h1')).toHaveText(`${message('statePaired')} · Chrome on MacBook Pro`);
    await expect(page.locator('#configured-and-associated')).toBeVisible();
    await expect(page.locator('#lock-database-button')).toBeVisible();
    await expect(page.locator('main section:visible')).toHaveCount(1);
});

test('The popup keeps the lock button\'s place while it is hidden, so Settings does not move', async ({ page }) => {
    await openPopup(page, { get_status: STATUS({ databaseClosed: true }) });
    await expect(page.locator('h1')).toHaveText(message('stateLocked'));
    await expect(page.locator('#lock-database-button')).toBeHidden();
    const gear = await page.locator('#options-button').boundingBox();
    expect(gear?.x).toBeGreaterThan(300);
});

test('Not reaching keypaste, by its absence or a timeout, names what to do once', async ({ page }) => {
    for (const status of [ STATUS({ keypasteAvailable: false }), STATUS({ error: message('errorMessageTimeout') }) ]) {
        await openPopup(page, { get_status: status });
        await expect(page.locator('h1')).toHaveText(message('errorNotConnected'));
        await expect(page.locator('#keypaste-unreachable')).toHaveText(new RegExp(message('popupGettingStartedText').replace(/[›.]/g, '.')));
        await expect(page.getByText('Settings › Browser')).toHaveCount(1);
    }
});

test('A problem keypaste reports says to try again and keeps its detail in the tooltip', async ({ page }) => {
    await openPopup(page, { get_status: STATUS({ error: message('errorMessageDatabaseHash') }) });
    await expect(page.locator('h1')).toHaveText(message('loginListRefused'));
    await expect(page.locator('#error-problem')).toHaveAttribute('title', message('errorMessageDatabaseHash'));
});

test('A pairing that ends unpaired says so above Pair this browser', async ({ page }) => {
    await openPopup(page, { get_status: STATUS({ configured: false, associated: false }), begin_pairing: { code: '482 913' }, associate: 0 });
    await expect(page.locator('#pairing-failed')).toBeHidden();
    await page.locator('#connect-button').click();
    await expect(page.locator('#pairing-failed')).toBeVisible();
    await expect(page.locator('h1')).toHaveText(message('stateNotPaired'));
});

test('While keypaste asks, the popup shows the code and that it is waiting', async ({ page }) => {
    await openPopup(page, { get_status: STATUS({ configured: false, associated: false }), begin_pairing: { code: '482 913' }, associate: 'pending' });
    await page.locator('#connect-button').click();
    await expect(page.locator('h1')).toHaveText(message('statePairing'));
    await expect(page.locator('#pairing-code')).toHaveText('482 913');
    await expect(page.locator('#checking-keypaste')).toContainText(message('pairingWaiting'));
});

test('Find login fields again says how many fields every frame found', async ({ page }) => {
    await openPopup(page, { get_status: STATUS() }, { redetect_fields: 1 });
    await page.locator('#redetect-fields-button').click();
    await expect(page.locator('#redetect-result')).toHaveText(message('popupRedetectFound').replace('$1', '2'));
});

test('The options page shows the pairing as rows and offers pairing only while unpaired', async ({ page }) => {
    const now = new Date();
    await stubExtension(page, { get_pairing: { id: 'Chrome on MacBook Pro', created: Date.parse('2026-11-02T10:14:00'), lastUsed: now.valueOf() } });
    await page.goto(pathToFileURL('src/options/options.html').toString());
    await expect(page.locator('#pairing-name')).toHaveText('Chrome on MacBook Pro');
    await expect(page.locator('#last-used')).toHaveText(/^Today /);
    await expect(page.locator('#paired-at')).not.toContainText(':');
    await expect(page.locator('#connect-button')).toBeHidden();
    await expect(page.locator('#version')).toHaveText('1.0.0');
});

test('The options page offers pairing while unpaired', async ({ page }) => {
    await stubExtension(page, { get_pairing: null });
    await page.goto(pathToFileURL('src/options/options.html').toString());
    await expect(page.locator('#not-paired')).toBeVisible();
    await expect(page.locator('#connect-button')).toBeVisible();
});

const CONTENT_SCRIPTS = [ 'common/browser-polyfill.min.js', 'common/global.js', 'common/sites.js', 'content/ui.js', 'content/autocomplete.js',
    'content/credential-autocomplete.js', 'content/fields.js', 'content/fill.js', 'content/form.js', 'content/icon.js',
    'content/icon-handler.js', 'content/keypaste.js', 'content/observer-helper.js', 'content/username-field.js' ];

// The page's list for an answer on a site's page, opened beside a field placed at left, its rows read through a shadow root left open.
const openList = async (page: Page, answer: Record<string, unknown>, left = 40) => {
    const extension = 'https://extension.test/';
    // The colors, which carry the list's fonts and spacing, arrive after its layout, as they may on a busy page.
    let layoutServed: () => void;
    const layout = new Promise<void>(resolve => layoutServed = resolve);
    await page.route(`${extension}**`, async route => {
        const path = new URL(route.request().url()).pathname.slice(1);
        if (path === 'css/colors.css') {
            await layout;
        }
        await route.fulfill({ path: `src/${path}` });
        if (path === 'css/autocomplete.css') {
            layoutServed();
        }
    });
    await page.route('https://site.test/', route => route.fulfill({ contentType: 'text/html',
        body: `<!doctype html><body><input id="field" style="position:absolute;top:40px;left:${left}px;width:200px"></body>` }));
    await stubExtension(page, { list_logins: answer, load_settings: {}, get_status: { keypasteAvailable: true }, is_connected: true, is_iframe_allowed: true }, {}, extension);
    await page.setViewportSize({ width: 480, height: 600 });
    await page.goto('https://site.test/');
    for (const script of CONTENT_SCRIPTS) {
        await page.addScriptTag({ path: `src/${script}` });
    }
    return page.evaluate(async () => {
        const opened = { open: Element.prototype._attachShadow };
        Element.prototype.attachShadow = function() {
            const root = opened.open.call(this, { mode: 'open' });
            Object.assign(window, { listRoot: root });
            return root;
        };
        kpxcFields.getCombination = async () => ({});
        kpxc.getFormActionUrl = () => '';
        await kpxcUserAutocomplete.open(document.getElementById('field'));
        const root = window.listRoot;
        await new Promise(resolve => setTimeout(resolve, 200));
        const container = root.querySelector('.kpxcAutocomplete-container').getBoundingClientRect();
        return {
            rows: [ ...root.querySelectorAll('.kpxcAutocomplete-action, .kpxcAutocomplete-warning, .kpxcAutocomplete-note') ]
                .map(row => [ row.textContent, row.querySelector('button')?.textContent ?? null ]),
            tiles: [ ...root.querySelectorAll('.kpxcAutocomplete-item__monogram') ].map(tile => tile.style.backgroundColor),
            left: container.left,
            right: container.right,
        };
    });
};

test('Each state of the page\'s list says what is so and offers the way forward', async ({ page }) => {
    for (const [ state, text, button ] of [
        [ 'unpaired', 'loginListNotPaired', 'loginListPair' ],
        [ 'disconnected', 'errorNotConnected', 'popupReloadButton' ],
        [ 'refused', 'loginListRefused', 'popupReloadButton' ],
        [ 'locked', 'loginListKeypasteLocked', 'loginListUnlock' ],
    ]) {
        const { rows } = await openList(page, { state });
        expect(rows).toEqual([ [ message(text) + message(button), message(button) ] ]);
    }
});

test('The page\'s list draws a warning as a row, no logins without the site again, and each login on its hue', async ({ page }) => {
    const warned = await openList(page, { state: 'unlocked', site: 'github.com', warning: 'This page\'s connection is not secure.', lockedVaults: [],
        entries: [ { name: 'GitHub', login: 'dan', uuid: '0123456789abcdef0123456789abcdef', vault: '' } ] });
    expect(warned.rows[0]).toEqual([ 'This page\'s connection is not secure.', null ]);
    expect(warned.tiles[0]).toBe(`var(--kp-tile-${tileHue('0123456789abcdef0123456789abcdef')})`);

    const empty = await openList(page, { state: 'unlocked', site: 'github.com', warning: '', lockedVaults: [], entries: [] });
    expect(empty.rows).toContainEqual([ message('loginListNoLogins'), null ]);
});

test('The page\'s list stays inside the viewport beside a field at its right edge', async ({ page }) => {
    const { left, right } = await openList(page, { state: 'unlocked', site: 'github.com', warning: '', lockedVaults: [],
        entries: [ { name: 'GitHub — personal account with a very long title that keeps going', login: 'dan', uuid: '0123456789abcdef0123456789abcdef', vault: 'Personal' } ] }, 300);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(right).toBeLessThanOrEqual(480 - 8);
});
