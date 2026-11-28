#!/usr/bin/env node
'use strict';

// scripts/verify-browser-fill.sh's browser half. tests/Keypaste.AppDriver holds a vault of logins and answers keypaste's
// pairing prompt; each browser loads keypaste's extension, pairs, and visits pages a local HTTPS server serves under test names,
// where a trusted click on the field's key icon opens keypaste's list of names and trusted keys pick one, as a person's do. Each
// page's fields and the owner's log must show what keypaste's rules allow: the list written as one line and no password before
// a pick, and a pick filled at once with no prompt and its fill recorded with the page's origin, on the item's site at the first
// visit and again, on a subdomain, on an http page and on a form posting elsewhere; a lookalike and another tenant of a shared
// host listing nothing; the fill shortcut with no field focused opening the list in the username, in the Chromium family,
// whose extension worker can run it; a sign-in split across pages, the username's page releasing no password and the password's page
// filled by the next click with no list; a one-time code filled after its login, by that click and by a pick; a frame from
// another site filled only with its own site's login once the person trusts it in keypaste, asked again once Settings removes
// that trust, and refused when they don't; a frame of the page's own site filled as the page is, with no question; and a
// sandboxed frame refused by the extension itself.
//
// Usage: fill-in-browsers.js <settings.json>, written by verify-browser-fill.sh:
//   { root, driver, keypaste, vault, real, geckodriver, cert, key, chromiumBuild, edgeBuild, firefoxBuild, chromeId, edgeId,
//     browsers: [ { name: chromium|chrome|edge|brave|firefox|librewolf, executable } ] }
// With real set, keypaste is turned on in the browsers' own places for this user, as on a runner that is thrown away;
// otherwise in folders under root.

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { chromium } = require('@playwright/test');
const { WAIT_MS, ELEMENT, FIREFOX_ID, STATUS_ACTION, escape, pause, readOr, listOr, report, statusOr, withinWait, until, freePort,
    HeldApp, pair, Gecko } = require('./browsers');

const settings = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { root, driver, keypaste, vault, real, geckodriver } = settings;

// The build each browser loads, the ID its store gives it, and how keypaste names it: Chromium and Brave take the Chrome Web
// Store's build, and Edge its own under Microsoft Edge Add-ons' key.
const chromeBuild = { build: settings.chromiumBuild, id: settings.chromeId, identity: `keypaste's extension from the Chrome Web Store (${settings.chromeId})` };
const BUILDS = {
    chromium: chromeBuild,
    chrome: chromeBuild,
    brave: chromeBuild,
    edge: { build: settings.edgeBuild, id: settings.edgeId, identity: `keypaste's extension from Microsoft Edge Add-ons (${settings.edgeId})` },
    firefox: { build: settings.firefoxBuild, identity: `keypaste's extension from Firefox Add-ons (${FIREFOX_ID})` },
};
// LibreWolf, a Firefox fork, runs the Firefox build and reads Firefox's manifest (HostPlaces.Slot).
BUILDS.librewolf = BUILDS.firefox;
const runsFirefoxAddOn = (name) => name === 'firefox' || name === 'librewolf';
const browsers = settings.browsers.map((browser) => ({ ...browser, ...BUILDS[browser.name] }));
const { KEYPASTE_DRIVER_PASSWORD: master, ...inherited } = process.env;
if (!master) {
    console.error('KEYPASTE_DRIVER_PASSWORD names no master password');
    process.exit(2);
}

// How long a page is watched for a prompt that must not come.
const QUIET_MS = 5000;
// Any line the driver prints about a prompt in keypaste, none of which a fill may bring.
const PROMPT = /^(\w+-)?prompt\b/;
const platform = process.platform;
const keypasteHome = path.join(root, 'keypaste-home');
const home = real ? os.homedir() : path.join(root, 'home');
const configHome = real ? (process.env.XDG_CONFIG_HOME || path.join(home, '.config')) : path.join(root, 'config');
const localAppData = real ? process.env.LOCALAPPDATA : path.join(root, 'localappdata');
const appData = real ? process.env.APPDATA : path.join(root, 'appdata');
const auditLog = path.join(keypasteHome, 'audit.jsonl');

// The places, as Core's HostPlaces names them, where each browser keeps its profiles and reads keypaste's manifest.
const hostPlaceDir = function(name) {
    const folder = {
        darwin: { chromium: 'Chromium', chrome: 'Google/Chrome', edge: 'Microsoft Edge', brave: 'BraveSoftware/Brave-Browser' },
        linux: { chromium: 'chromium', chrome: 'google-chrome', edge: 'microsoft-edge', brave: 'BraveSoftware/Brave-Browser' },
    }[platform]?.[name];
    if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', folder);
    }
    if (platform === 'linux') {
        return path.join(configHome, folder);
    }
    // Windows reads the manifest through the registry, so any folder holds the profile.
    return path.join(root, 'profiles', name);
};

// A browser refuses DevTools on its default profile folder, so each runs in a folder of its own whose NativeMessagingHosts is
// the one keypaste wrote; Windows reads the registry wherever the profile is.
const userDataDir = function(name) {
    if (platform === 'win32') {
        return hostPlaceDir(name);
    }
    const own = path.join(root, 'profiles', name);
    fs.mkdirSync(own, { recursive: true });
    const hosts = path.join(own, 'NativeMessagingHosts');
    fs.rmSync(hosts, { force: true });
    fs.symlinkSync(manifestDirectory(name), hosts, 'dir');
    return own;
};

const manifestDirectory = function(name) {
    if (platform === 'win32') {
        return path.join(localAppData, 'keypaste', 'NativeMessagingHosts');
    }
    if (runsFirefoxAddOn(name)) {
        return platform === 'darwin'
            ? path.join(home, 'Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts')
            : path.join(home, '.mozilla', 'native-messaging-hosts');
    }
    // Brave on macOS reads Chrome's folder, where keypaste writes its manifest (HostPlaces.Slot).
    return path.join(hostPlaceDir(platform === 'darwin' && name === 'brave' ? 'chrome' : name), 'NativeMessagingHosts');
};

const ownerEnvironment = {
    ...inherited,
    HOME: home,
    KEYPASTE_HOME: keypasteHome,
    KEYPASTE_DRIVER_PASSWORD: master,
    KEYPASTE_DRIVER_BROWSER_PROGRAM: keypaste,
    KEYPASTE_DRIVER_BROWSER_HOME: home,
    KEYPASTE_DRIVER_BROWSER_USERPROFILE: real ? os.homedir() : home,
    KEYPASTE_DRIVER_BROWSER_XDG_CONFIG_HOME: configHome,
    KEYPASTE_DRIVER_BROWSER_APPDATA: appData,
    KEYPASTE_DRIVER_BROWSER_LOCALAPPDATA: localAppData,
    KEYPASTE_DRIVER_BROWSER_REGISTRY_ROOT: real ? 'Software' : 'Software\\keypaste-tests\\browser-fill',
};
// What each browser passes to the keypaste it starts: the user folders the host was set up in, and the held vault.
const browserEnvironment = { ...inherited, HOME: home, XDG_CONFIG_HOME: configHome, KEYPASTE_HOME: keypasteHome, KEYPASTE_VAULT: vault };

// The pages. Every name resolves to this machine; the certificate names them all.
const NAMES = {
    shop: 'shop.test',
    www: 'www.shop.test',
    frame: 'login.shop.test',
    lookalike: 'shop.test.evil.test',
    other: 'pay.other.test',
    mail: 'mail.test',
    alice: 'alice.github.io',
    bob: 'bob.github.io',
    router: 'router.test',
};

const field = 'display:block;box-sizing:border-box;width:320px;height:40px;margin:12px;font-size:16px';
const form = (action) => `<form method="post" action="${action}">
<input id="username" name="username" autocomplete="username" style="${field}">
<input id="password" name="password" type="password" autocomplete="current-password" style="${field}">
<button type="submit" style="margin:12px">Sign in</button>
</form>`;
const onlyUsername = `<form method="post" action="/next">
<input id="username" name="username" autocomplete="username" style="${field}">
<button type="submit" style="margin:12px">Next</button>
</form>`;
const onlyPassword = `<form method="post" action="/session">
<input id="password" name="password" type="password" autocomplete="current-password" style="${field}">
<button type="submit" style="margin:12px">Sign in</button>
</form>`;
const oneTimeCode = `<form method="post" action="/verify">
<input id="code" name="code" autocomplete="one-time-code" inputmode="numeric" style="${field}">
<button type="submit" style="margin:12px">Verify</button>
</form>`;
const frameOf = (src, sandbox = '') => `<iframe id="frame" ${sandbox} src="${src}" style="width:400px;height:240px;border:0"></iframe>`;
const pageOf = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0">${body}</body></html>`;

// The forms the pages posted, which a fill never does.
const submitted = [];

const serve = function(port, httpsPort) {
    return (request, response) => {
        const url = new URL(request.url, `https://${request.headers.host}`);
        let body;
        if (url.pathname === '/login') {
            body = pageOf('Sign in', form('/session'));
        } else if (url.pathname === '/cross') {
            body = pageOf('Sign in', form(`https://${NAMES.other}:${httpsPort}/session`));
        } else if (url.pathname === '/username') {
            body = pageOf('Sign in', onlyUsername);
        } else if (url.pathname === '/password') {
            body = pageOf('Sign in', onlyPassword);
        } else if (url.pathname === '/otp') {
            body = pageOf('Verify', oneTimeCode);
        } else if (url.pathname === '/framed') {
            body = pageOf('Framed', frameOf(`https://${NAMES.frame}:${httpsPort}/login?next=/frame`));
        } else if (url.pathname === '/framed-other') {
            body = pageOf('Framed', frameOf(`https://${NAMES.other}:${httpsPort}/login?next=/frame`));
        } else if (url.pathname === '/sandboxed') {
            body = pageOf('Framed', frameOf(`https://${NAMES.shop}:${httpsPort}/login?next=/frame`, 'sandbox="allow-scripts allow-forms"'));
        } else {
            if (request.method === 'POST') {
                submitted.push(`${request.headers.host}${url.pathname}`);
            }
            response.writeHead(request.method === 'POST' ? 204 : 404);
            response.end();
            return;
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(body);
    };
};

const startServers = async function() {
    const httpsPort = await freePort();
    const httpPort = await freePort();
    const secure = https.createServer({ cert: fs.readFileSync(settings.cert), key: fs.readFileSync(settings.key) }, serve(httpsPort, httpsPort));
    const plain = http.createServer(serve(httpPort, httpsPort));
    await Promise.all([ [ secure, httpsPort ], [ plain, httpPort ] ].map(([ server, port ]) =>
        new Promise((resolve, reject) => server.on('error', reject).listen(port, '127.0.0.1', resolve))));
    return { httpsPort, httpPort, close: () => Promise.all([ secure, plain ].map((server) => new Promise((resolve) => server.close(resolve)))) };
};

// The logins, each a password no page and no log line may show.
const logins = (ports) => [
    { title: 'Shop', username: 'dana', password: `shop-dana-${crypto.randomUUID()}`, url: `https://${NAMES.shop}:${ports.httpsPort}` },
    { title: 'Shop work', username: 'sam', password: `shop-sam-${crypto.randomUUID()}`, url: `https://${NAMES.shop}:${ports.httpsPort}` },
    { title: 'Mail', username: 'dana', password: `mail-dana-${crypto.randomUUID()}`, url: `https://${NAMES.mail}:${ports.httpsPort}` },
    { title: 'Pages', username: 'alice', password: `pages-alice-${crypto.randomUUID()}`, url: `https://${NAMES.alice}:${ports.httpsPort}` },
    { title: 'Router', username: 'admin', password: `router-admin-${crypto.randomUUID()}`, url: `http://${NAMES.router}:${ports.httpPort}` },
    { title: 'Pay', username: 'pat', password: `pay-pat-${crypto.randomUUID()}`, url: `https://${NAMES.other}:${ports.httpsPort}` },
];

// Mail's one-time code: a TOTP seed in KeePassXC's otp field, which keypaste turns into a code and never sends.
const MAIL_SEED = 'JBSWY3DPEHPK3PXP';
const MAIL_OTP = `otpauth://totp/Mail:dana?secret=${MAIL_SEED}&issuer=Mail&period=30&digits=6&algorithm=SHA1`;

// RFC 6238's code for a base32 seed at a time step, as keypaste computes it.
const totpAt = function(seed, step) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = [ ...seed ].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('');
    const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const mac = crypto.createHmac('sha1', key).update(counter).digest();
    const offset = mac[mac.length - 1] & 0x0f;
    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
};

// The codes that are current around now, one step either side, since the fill and the check fall in different moments.
const currentCodes = function(seed) {
    const step = Math.floor(Date.now() / 30000);
    return [ step - 1, step, step + 1 ].map((at) => totpAt(seed, at));
};

const addLogins = function(items) {
    for (const item of items) {
        const added = spawnSync(keypaste, [ 'add', item.title, '--username', item.username, '--url', item.url, '--notes', '', '--vault', vault ], {
            env: { ...inherited, HOME: home, KEYPASTE_HOME: keypasteHome },
            input: `${master}\n${item.password}\n`,
            encoding: 'utf8',
        });
        if (added.status !== 0) {
            throw new Error(`keypaste add ${item.title} exited ${added.status}: ${added.stderr}`);
        }
    }

    // keypaste leaves KeePassXC's otp field to its own one-time-code setup, which the driver does as the item pane does.
    const otp = spawnSync(driver, [ 'totp', vault, '', 'Mail' ], {
        env: { ...inherited, HOME: home, KEYPASTE_HOME: keypasteHome, KEYPASTE_DRIVER_PASSWORD: master },
        input: `${MAIL_OTP}\n`,
        encoding: 'utf8',
    });
    if (otp.status !== 0) {
        throw new Error(`the driver's totp for Mail exited ${otp.status}: ${otp.stderr}`);
    }
};

// What the page shows: its fields' values, and how many of the extension's own elements sit in its body, where the pages put
// no div. The extension holds an icon's wrapper at 'all: unset' (ui.js), and shows a notification such as "no logins found"
// in one it displays.
const PAGE_STATE = `
    const value = (id) => document.getElementById(id)?.value ?? null;
    const ours = [ ...document.body.children ].filter((element) => element.tagName === 'DIV');
    const rect = (document.getElementById('username') ?? document.getElementById('password') ?? document.getElementById('code'))?.getBoundingClientRect();
    return {
        username: value('username'),
        password: value('password'),
        code: value('code'),
        focused: document.activeElement?.id ?? '',
        icons: ours.filter((element) => element.style.cssText === 'all: unset;').length,
        notices: ours.filter((element) => element.style.display === 'block').length,
        divs: ours.length,
        styles: ours.map((element) => element.style.cssText.slice(0, 60)),
        field: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
    };`;

// Where the extension draws the key icon on a 40-pixel field: its right end, centred, as icon-handler.js places it.
const iconPoint = (rect) => ({ x: rect.left + rect.width - 19, y: rect.top + rect.height / 2 });


// A Chromium-family browser started here, so its standard error, where the hosts it starts write theirs, reaches a file. The
// extension is loaded over the DevTools pipe, as branded Chrome no longer loads one from its command line, and pages are driven
// through the DevTools port.
const launchChromiumFamily = async function(browser, log, spki) {
    // The browser's own password manager stays off, so whatever fills a page is keypaste.
    const preferences = path.join(userDataDir(browser.name), 'Default', 'Preferences');
    fs.mkdirSync(path.dirname(preferences), { recursive: true });
    fs.writeFileSync(preferences, JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false } }));
    const child = spawn(browser.executable, [
        '--headless',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--password-store=basic',
        '--use-mock-keychain',
        '--enable-logging=stderr',
        '--v=0',
        '--remote-debugging-pipe',
        '--remote-debugging-port=0',
        '--enable-unsafe-extension-debugging',
        `--host-resolver-rules=${Object.values(NAMES).map((name) => `MAP ${name} 127.0.0.1`).join(',')}`,
        `--ignore-certificate-errors-spki-list=${spki}`,
        '--disable-features=HttpsUpgrades',
        `--user-data-dir=${userDataDir(browser.name)}`,
        'about:blank',
    ], { env: browserEnvironment, stdio: [ 'ignore', 'pipe', 'pipe', 'pipe', 'pipe' ] });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const out = fs.createWriteStream(log);
    child.stdout.pipe(out, { end: false });
    let devtools;
    const stop = async () => {
        await devtools?.close().catch(() => {});
        child.kill();
        await withinWait(exited, `${browser.name} to exit`);
        await new Promise((resolve) => out.end(resolve));
    };
    try {
        const endpoint = await withinWait(new Promise((resolve, reject) => {
            readline.createInterface({ input: child.stderr }).on('line', (line) => {
                out.write(line + '\n');
                const listening = /DevTools listening on (ws:\/\/\S+)/.exec(line);
                if (listening) {
                    resolve(listening[1]);
                }
            });
            exited.then((code) => reject(new Error(`${browser.name} exited with ${code} before it listened for DevTools`)));
        }), `${browser.name} to listen for DevTools`);

        // The pipe's messages are JSON, each ended by a NUL.
        const loaded = withinWait(new Promise((resolve, reject) => {
            let pending = '';
            child.stdio[4].on('data', (chunk) => {
                pending += chunk.toString('utf8');
                let end;
                while ((end = pending.indexOf('\0')) >= 0) {
                    const message = JSON.parse(pending.slice(0, end));
                    pending = pending.slice(end + 1);
                    if (message.id === 1) {
                        message.error ? reject(new Error(`Extensions.loadUnpacked: ${message.error.message}`)) : resolve(message.result.id);
                    }
                }
            });
        }), `${browser.name} to load the extension`);
        child.stdio[3].write(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: browser.build } }) + '\0');
        const id = await loaded;
        if (id !== browser.id) {
            throw new Error(`${browser.name} loaded the extension as ${id}, not ${browser.id}`);
        }

        devtools = await chromium.connectOverCDP(endpoint);
        const context = devtools.contexts()[0];
        const version = devtools.version();
        return { context, version, stop };
    } catch (error) {
        await stop();
        throw error;
    }
};

// A page of a Chromium-family browser, through Playwright.
class ChromiumTab {
    constructor(page, extensionId) {
        this.page = page;
        this.extensionId = extensionId;
    }

    // No automation presses a browser's own shortcut, so the extension's worker runs its handler of one as the browser does.
    async shortcut(command) {
        const worker = this.page.context().serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${this.extensionId}/`));
        if (!worker) {
            throw new Error(`the worker of the extension ${this.extensionId} is not running`);
        }
        // The handler sends the shortcut to the current tab, which the browser started with beside this one.
        await this.page.bringToFront();
        const current = await worker.evaluate('getCurrentTab().then((tab) => tab?.url ?? \'\')');
        if (current !== this.page.url()) {
            throw new Error(`the extension's current tab is ${current || 'none'}, not ${this.page.url()}`);
        }
        await worker.evaluate(`runShortcut(${JSON.stringify(command)})`);
    }

    async goto(url) {
        await this.page.goto(url, { waitUntil: 'load' });
    }

    async reload() {
        await this.page.reload({ waitUntil: 'load' });
    }

    // The page's state, in its frame when framed names one.
    async state(framed = false) {
        const frame = framed ? await (await this.page.$('#frame')).contentFrame() : this.page.mainFrame();
        const state = await frame.evaluate(`(() => {${PAGE_STATE}})()`);
        if (framed && state.field) {
            const box = await (await this.page.$('#frame')).boundingBox();
            state.field.left += box.x;
            state.field.top += box.y;
        }
        return state;
    }

    // A click at a point of the page, or, framed, through the frame's own locator at the point within it, so it lands in the
    // frame however the browser runs it.
    async clickAt({ x, y }, framed = false) {
        if (!framed) {
            await this.page.mouse.click(x, y);
            return;
        }
        const box = await (await this.page.$('#frame')).boundingBox();
        await this.page.frameLocator('#frame').locator('html').click({ position: { x: x - box.x, y: y - box.y }, force: true });
    }

    // A trusted key press to whatever has focus; the browser routes it into a frame that holds the focus.
    async press(key, _framed = false) {
        await this.page.keyboard.press(key);
    }

    // What the page's own document has at a point: a shadow root the extension draws in shows as its host.
    at({ x, y }, framed = false) {
        if (!framed) {
            return this.page.evaluate(`document.elementFromPoint(${x}, ${y})?.tagName ?? ''`);
        }
        return (async () => {
            const element = await this.page.$('#frame');
            const box = await element.boundingBox();
            return (await element.contentFrame()).evaluate(`document.elementFromPoint(${x - box.x}, ${y - box.y})?.tagName ?? ''`);
        })();
    }

}

// A page of Firefox, through geckodriver.
class FirefoxTab {
    constructor(gecko) {
        this.gecko = gecko;
    }

    // geckodriver reaches neither the browser's shortcuts nor the add-on's background page.
    shortcut = undefined;

    async goto(url) {
        await this.gecko.session('POST', '/url', { url });
    }

    async reload() {
        await this.gecko.session('POST', '/refresh', {});
    }

    async state(framed = false) {
        if (!framed) {
            return this.gecko.evaluate(PAGE_STATE);
        }
        const frame = await this.gecko.element('#frame');
        const box = await this.gecko.session('GET', `/element/${frame}/rect`);
        await this.gecko.session('POST', '/frame', { id: { [ELEMENT]: frame } });
        try {
            const state = await this.gecko.evaluate(PAGE_STATE);
            if (state.field) {
                state.field.left += box.x;
                state.field.top += box.y;
            }
            return state;
        } finally {
            await this.gecko.session('POST', '/frame/parent', {});
        }
    }

    // Framed, the click is sent in the frame's own browsing context, at the point within it, so it reaches a frame Firefox runs
    // in another process; from the top document's it reached a frame of the page's site but not one of another site.
    async clickAt({ x, y }, framed = false) {
        if (!framed) {
            await this.gecko.clickAt(x, y);
            return;
        }
        const frame = await this.gecko.element('#frame');
        const box = await this.gecko.session('GET', `/element/${frame}/rect`);
        await this.gecko.session('POST', '/frame', { id: { [ELEMENT]: frame } });
        try {
            await this.gecko.clickAt(x - box.x, y - box.y);
        } finally {
            await this.gecko.session('POST', '/frame/parent', {});
        }
    }

    // Framed, the press is sent in the frame's own browsing context, as a framed click is, so it reaches the field focused in a
    // frame Firefox runs in another process.
    async press(key, framed = false) {
        if (!framed) {
            await this.gecko.press(key);
            return;
        }
        const frame = await this.gecko.element('#frame');
        await this.gecko.session('POST', '/frame', { id: { [ELEMENT]: frame } });
        try {
            await this.gecko.press(key);
        } finally {
            await this.gecko.session('POST', '/frame/parent', {});
        }
    }

    async at({ x, y }, framed = false) {
        if (!framed) {
            return this.gecko.evaluate(`return document.elementFromPoint(${x}, ${y})?.tagName ?? '';`);
        }
        const frame = await this.gecko.element('#frame');
        const box = await this.gecko.session('GET', `/element/${frame}/rect`);
        await this.gecko.session('POST', '/frame', { id: { [ELEMENT]: frame } });
        try {
            return await this.gecko.evaluate(`return document.elementFromPoint(${x - box.x}, ${y - box.y})?.tagName ?? '';`);
        } finally {
            await this.gecko.session('POST', '/frame/parent', {});
        }
    }

}

const auditText = () => readOr(auditLog);


// The acts every browser performs, on one pairing of its own.
const fillActs = async function(app, tab, ports, items, name) {
    const [ shopDana, shopSam, mail, , router, pay ] = items;
    const at = (host, pagePath, port = ports.httpsPort, scheme = 'https') => `${scheme}://${host}:${port}${pagePath}`;
    const origin = (host, port = ports.httpsPort, scheme = 'https') => `${scheme}://${host}:${port}`;

    // The page's fields have their icon once the extension has read the page, and only once it is placed is it under the point a
    // click aims at, in the frame's own document for a framed field; a click before then, as just after a reload, lands on nothing.
    const ready = (framed = false) => until(async () => {
        const state = await tab.state(framed);
        if (!state.field || state.icons === 0) {
            return undefined;
        }
        return (await tab.at(iconPoint(state.field), framed)).startsWith('DIV') ? state : undefined;
    }, `${name} to draw and place keypaste's icon`);

    // A click on the icon opens keypaste's list beside the field, a div more in the page, and writes one line when it names a
    // login. Brave has let a first click on a page just opened do nothing (BACKLOG), so one more click is allowed and printed.
    const opened = async (framed = false) => {
        const before = (await ready(framed)).divs;
        const point = iconPoint((await ready(framed)).field);
        await tab.clickAt(point, framed);
        await until(async () => (await tab.state(framed)).divs > before || undefined, `${name} to open keypaste's list`, QUIET_MS * 2).catch(async () => {
            console.log(`${name}: a click brought no list; clicking again`);
            await tab.clickAt(point, framed);
            await until(async () => (await tab.state(framed)).divs > before || undefined, `${name} to open keypaste's list`);
        });
    };

    // The list's line for an origin, naming how many logins it showed and no password.
    const listed = (expectedOrigin, count, since) => until(async () => {
        const lines = auditText().slice(since).split('\n').filter((line) => line.includes('"field":"list"') && line.includes(expectedOrigin));
        return lines.find((line) => line.includes(`listed ${count} login(s) by name, no password`));
    }, `${name}'s list of ${count} login(s) on ${expectedOrigin} to be recorded`);

    // The fill shortcut with no field focused opens keypaste's list in the page's first login field, which it focuses, as the
    // field's key icon opens it.
    const openedByShortcut = (fieldId) => async () => {
        const before = await ready();
        if (before.focused !== '') {
            throw new Error(`${name}: ${before.focused} had the focus before the fill shortcut`);
        }
        await tab.shortcut('fill_username_password');
        const shown = await until(async () => {
            const state = await tab.state();
            return state.divs > before.divs ? state : undefined;
        }, `${name} to open keypaste's list from the fill shortcut`);
        if (shown.focused !== fieldId) {
            throw new Error(`${name}: the fill shortcut focused ${shown.focused || 'nothing'}, not ${fieldId}`);
        }
    };

    // Opens the list on the page, waits for its line, and picks the login at row (from 1) with the keys, focus being in the field.
    const pickRow = async (expectedOrigin, count, row, framed = false, open = opened) => {
        const since = auditText().length;
        await open(framed);
        await listed(expectedOrigin, count, since);
        // A pick counts only once the list has been on screen a moment (autocomplete.js).
        await pause(800);
        for (let i = 1; i < row; i++) {
            await tab.press('ArrowDown', framed);
        }
        await tab.press('Enter', framed);
    };

    // The page's fields hold the item's username and password, or only those of the two the page has.
    const filledWith = (item, framed = false) => {
        let seen;
        return until(async () => {
            seen = await tab.state(framed);
            const username = seen.username === null || seen.username === item.username;
            const password = seen.password === null || seen.password === item.password;
            return username && password && (seen.username ?? seen.password) !== null ? seen : undefined;
        }, `${name} to fill ${item.title}`).catch((error) => {
            throw new Error(`${error.message}; the page showed ${seen?.username} with ${seen?.password ? 'a password' : 'no password'}, `
                + `forms posted: ${submitted.join(', ') || 'none'}`);
        });
    };

    // The owner's granted fill lines since a point, by how they were decided.
    const fillLines = (since, method) => auditText().slice(since).split('\n')
        .filter((line) => line.includes('"field":"fill"') && line.includes('"decision":"granted"') && line.includes(`"method":"${method}"`));

    // A pick keypaste fills at once, asking nobody, its fill recorded in the owner's log with the page's origin.
    const atOnce = async (expectedOrigin, count, row, item, framed = false, open = opened) => {
        const prompts = app.watch(PROMPT);
        const since = auditText().length;
        await pickRow(expectedOrigin, count, row, framed, open);
        await filledWith(item, framed);
        prompts.stop();
        if (prompts.lines.length > 0) {
            throw new Error(`${name}: a pick of ${item.title} on ${expectedOrigin} brought a prompt: ${prompts.lines[0]}`);
        }
        if (!fillLines(since, 'picked').some((line) => line.includes(`on ${expectedOrigin}`))) {
            throw new Error(`${name}: the owner's log names no fill of ${item.title} on ${expectedOrigin}`);
        }
    };

    // A click on the key icon that continues the tab's last fill: the field fills with no list and no prompt, and the owner
    // records a continued fill, never a list, on the page's origin.
    const continued = async (expectedOrigin, what, holds) => {
        const prompts = app.watch(PROMPT);
        const since = auditText().length;
        const state = await ready();
        await tab.clickAt(iconPoint(state.field));
        let seen;
        await until(async () => {
            seen = await tab.state();
            return holds(seen) || undefined;
        }, `${name} to fill ${what} with no list`).catch((error) => {
            throw new Error(`${error.message}; the page showed ${JSON.stringify({ ...seen, password: seen?.password ? '(a password)' : seen?.password })}`);
        });
        prompts.stop();
        if (prompts.lines.length > 0) {
            throw new Error(`${name}: the continued fill of ${what} brought a prompt: ${prompts.lines[0]}`);
        }
        if ((await tab.state()).divs > state.divs) {
            throw new Error(`${name}: the continued fill of ${what} opened keypaste's list`);
        }
        const recorded = auditText().slice(since).split('\n');
        if (recorded.some((line) => line.includes('"field":"list"'))) {
            throw new Error(`${name}: the continued fill of ${what} listed logins`);
        }
        if (!fillLines(since, 'continued').some((line) => line.includes(`on ${expectedOrigin}`))) {
            throw new Error(`${name}: the owner's log names no continued fill of ${what} on ${expectedOrigin}`);
        }
    };

    // A frame the person refuses to trust when keypaste asks: its list opens with no login, nothing is filled, and nothing is listed.
    const refusedFrame = async (topHost, frameHost) => {
        const since = auditText().length;
        const before = (await ready(true)).divs;
        await askedToTrust(topHost, frameHost, 'deny');
        await until(async () => (await tab.state(true)).divs > before || undefined, `${name} to open keypaste's list in the refused frame`);
        await pause(1000);
        await tab.press('Enter', true);
        await pause(1000);
        if (auditText().slice(since).split('\n').some((line) => line.includes('"field":"list"') || (line.includes('"field":"fill"') && line.includes('"decision":"granted"')))) {
            throw new Error(`${name}: the refused frame from ${frameHost} listed or filled a login`);
        }
        const state = await tab.state(true);
        if (state.username || state.password) {
            throw new Error(`${name}: the refused frame from ${frameHost} was filled with ${state.username}`);
        }
    };

    const holdsCode = (seed) => (state) => currentCodes(seed).includes(state.code);

    // A click in a frame keypaste asks the person about: the trust question names the tab's host and the frame's, and is answered.
    const askedToTrust = async (topHost, frameHost, answer) => {
        const before = (await ready(true)).divs;
        const asked = app.next(/^frame-prompt /, WAIT_MS).catch(async (error) => {
            // Whether the click opened keypaste's list in the frame tells a click that never arrived from a frame the extension refused.
            const after = await tab.state(true).catch(() => undefined);
            throw new Error(`${error.message}; the frame then held ${after?.divs ?? 'unknown'} of the extension's elements against ${before} before the click`);
        });
        const point = iconPoint((await ready(true)).field);
        await tab.clickAt(point, true);
        // Brave has let a first click on a page just opened do nothing (BACKLOG), so one more click is allowed and printed.
        const shown = await Promise.race([ asked, pause(QUIET_MS * 2).then(() => undefined) ]) ?? await (async () => {
            console.log(`${name}: a click asked nothing; clicking again`);
            await tab.clickAt(point, true);
            return asked;
        })();
        const match = /^frame-prompt pairing=(.+) top=(\S+) frame=(\S+)$/.exec(shown);
        if (!match || match[2] !== topHost || match[3] !== frameHost) {
            throw new Error(`${name}: keypaste asked ${shown}, not about ${frameHost} on ${topHost}`);
        }
        app.send(answer);
        return match[1];
    };

    // A click that lists nothing: the list opens, keypaste records no list line for the host and asks nobody, and the fields stay empty.
    const nothingListed = async (what, host, framed = false) => {
        const prompts = app.watch(PROMPT);
        const since = auditText().length;
        await opened(framed);
        await pause(1000);
        await tab.press('Enter', framed);
        await pause(1000);
        prompts.stop();
        if (prompts.lines.length > 0) {
            throw new Error(`${name}: ${what} brought a prompt: ${prompts.lines[0]}`);
        }
        if (auditText().slice(since).split('\n').some((line) => line.includes('"field":"list"') && line.includes(host))) {
            throw new Error(`${name}: ${what} listed a login`);
        }
        const state = await tab.state(framed);
        if (state.username || state.password) {
            throw new Error(`${name}: ${what} filled ${state.username}`);
        }
    };

    // The item's own site lists both of its logins by name; a pick of each fills at once, the first visit included.
    await tab.goto(at(NAMES.shop, '/login?next=/account'));
    await atOnce(origin(NAMES.shop), 2, 1, shopDana);
    await tab.reload();
    await atOnce(origin(NAMES.shop), 2, 2, shopSam);

    // A subdomain of the item's site lists its logins, and a pick there fills at once.
    await tab.goto(at(NAMES.www, '/login'));
    await atOnce(origin(NAMES.www), 2, 1, shopDana);

    // A lookalike name and another tenant of a shared host list nothing, and nobody is asked.
    await tab.goto(at(NAMES.lookalike, '/login'));
    await nothingListed('a lookalike of the item\'s site', NAMES.lookalike);
    await tab.goto(at(NAMES.bob, '/login'));
    await nothingListed('another tenant of github.io', NAMES.bob);

    // The fill shortcut with no field focused opens the list in the username, and a pick there fills at once.
    if (tab.shortcut) {
        await tab.goto(at(NAMES.shop, '/login'));
        await atOnce(origin(NAMES.shop), 2, 1, shopDana, false, openedByShortcut('username'));
    } else {
        console.log(`${name}: the fill shortcut is not run, as nothing here reaches the browser's own shortcuts`);
    }

    // An http page, and a form that posts to another site, which the list warns of, fill at once at the person's pick.
    await tab.goto(at(NAMES.router, '/login', ports.httpPort, 'http'));
    await atOnce(origin(NAMES.router, ports.httpPort, 'http'), 1, 1, router);
    await tab.goto(at(NAMES.shop, '/cross'));
    await atOnce(origin(NAMES.shop), 2, 1, shopDana);

    // A site with one login fills at once at the first pick and the next.
    await tab.goto(at(NAMES.mail, '/login'));
    await atOnce(origin(NAMES.mail), 1, 1, mail);
    await tab.reload();
    await atOnce(origin(NAMES.mail), 1, 1, mail);

    // Mail's one-time code fills after its login by the next click in the code's field, with no list, and later at a pick there.
    await tab.goto(at(NAMES.mail, '/otp'));
    await continued(origin(NAMES.mail), 'Mail\'s one-time code', holdsCode(MAIL_SEED));
    await tab.reload();
    await pickRow(origin(NAMES.mail), 1, 1);
    await until(async () => holdsCode(MAIL_SEED)(await tab.state()) || undefined, `${name} to fill Mail's one-time code at a pick`);

    // A sign-in split across pages: the username's page gets only the username, so no password leaves keypaste, and the next
    // click on the password's page fills the password with no list and no second pick; keypaste continues only what was left.
    await tab.goto(at(NAMES.shop, '/username'));
    await atOnce(origin(NAMES.shop), 2, 2, { ...shopSam, password: null });
    await tab.goto(at(NAMES.shop, '/password'));
    await continued(origin(NAMES.shop), 'Shop work\'s password', (state) => state.password === shopSam.password);

    // A frame from another site lists only its own site's logins, never the tab's, once the person trusts it in keypaste: the
    // first click asks, the pick fills the frame's login, and the next visit fills at once, asking nobody.
    await tab.goto(at(NAMES.shop, '/framed-other'));
    let since = auditText().length;
    const closed = (await ready(true)).divs;
    const pairing = await askedToTrust(NAMES.shop, NAMES.other, 'allow');
    await until(async () => (await tab.state(true)).divs > closed || undefined, `${name} to open keypaste's list in the trusted frame`);
    await listed(origin(NAMES.other), 1, since);
    await pause(800);
    await tab.press('Enter', true);
    await filledWith(pay, true);
    // keypaste's line names the page the frame is in after the frame's own origin, so only a list of the page itself is a leak.
    if (auditText().slice(since).split('\n').some((line) => line.includes('"field":"list"') && line.includes(`no password, on ${origin(NAMES.shop)}`))) {
        throw new Error(`${name}: the frame from ${NAMES.other} listed ${NAMES.shop}'s logins`);
    }
    await tab.reload();
    await atOnce(origin(NAMES.other), 1, 1, pay, true);
    const trusted = await app.act('frames', new RegExp(`^frame pairing=${escape(pairing)} top=${escape(NAMES.shop)} frame=${escape(NAMES.other)}$|^frames none$`));
    if (trusted === 'frames none') {
        throw new Error(`${name}: Settings lists no trust of ${NAMES.other} on ${NAMES.shop}`);
    }

    // Removed in Settings, the trust is asked for again; refused, the frame gets nothing.
    const removed = await app.act(`distrust ${NAMES.shop} ${NAMES.other}`, /^(not )?distrusted\b/);
    if (removed !== `distrusted ${NAMES.shop} ${NAMES.other}`) {
        throw new Error(`${name}: Settings did not remove the trust: ${removed}`);
    }
    await tab.reload();
    await refusedFrame(NAMES.shop, NAMES.other);

    // A frame of the page's own site fills as the page does, with its own logins and no question.
    await tab.goto(at(NAMES.shop, '/framed'));
    await atOnce(origin(NAMES.frame), 2, 1, shopDana, true);

    // A sandboxed frame, even of the tab's own address, is refused by the extension before keypaste is asked.
    since = auditText().length;
    await tab.goto(at(NAMES.shop, '/sandboxed'));
    await nothingListed('a sandboxed frame', NAMES.shop, true);
    if (auditText().slice(since).split('\n').some((line) => line.includes('"tool":"browser"') && !line.includes('"field":"check"'))) {
        throw new Error(`${name}: the sandboxed frame reached keypaste`);
    }
};

const requireAudit = function(items, ports) {
    const log = auditText();
    for (const item of items) {
        if (log.includes(item.password)) {
            throw new Error(`the owner's log holds ${item.title}'s password`);
        }
    }
    if (log.includes('next=')) {
        throw new Error('the owner\'s log holds a page\'s path or query: next=');
    }
    // A path follows a host or port, never a scheme's "//", so an origin such as https://login.shop.test is not taken for one.
    for (const leak of [ '/login', '/account', '/cross' ]) {
        if (new RegExp(`[^/]${leak}`).test(log)) {
            throw new Error(`the owner's log holds a page's path or query: ${leak}`);
        }
    }
    if (log.includes(MAIL_SEED)) {
        throw new Error('the owner\'s log holds Mail\'s one-time code seed');
    }
    for (const expected of [ `https://${NAMES.shop}:${ports.httpsPort}`, `http://${NAMES.router}:${ports.httpPort}`, `https://${NAMES.mail}:${ports.httpsPort}`, `https://${NAMES.other}:${ports.httpsPort}` ]) {
        if (!log.includes(expected)) {
            throw new Error(`the owner's log names no fill on ${expected}`);
        }
    }
};

const runChromiumFamily = async function(app, browser, ports, items, spki) {
    const log = path.join(root, `${browser.name}.log`);
    const consoles = [];
    let page;
    let stop = async () => {};
    try {
        const launched = await launchChromiumFamily(browser, log, spki);
        stop = launched.stop;
        console.log(`${browser.name}: ${launched.version}`);
        const { context } = launched;
        const listen = (worker) => worker.on('console', (message) => consoles.push(`worker ${message.type()}: ${message.text()}`));
        context.on('serviceworker', listen);
        context.serviceWorkers().forEach(listen);

        page = await context.newPage();
        page.on('console', (message) => consoles.push(`page ${message.type()}: ${message.text()}`));
        page.on('pageerror', (error) => consoles.push(`page error: ${error.message}`));
        await page.goto(`chrome-extension://${browser.id}/options/options.html`);
        await page.locator('#paired').waitFor({ state: 'hidden' });
        // Connect is pressed at once, while the extension's worker may still be starting, as a person might.
        await pair(app, browser.identity, () => page.locator('#connect-button').click());
        await page.locator('#paired').waitFor({ state: 'visible' });
        await fillActs(app, new ChromiumTab(page, browser.id), ports, items, browser.name);
    } catch (error) {
        const shown = page ? await new ChromiumTab(page).state().then((state) => `${page.url()} ${JSON.stringify(state)}`, (reason) => `(${reason.message})`) : '(no page)';
        const status = page?.url().startsWith('chrome-extension://')
            ? await statusOr(() => page.evaluate((message) => chrome.runtime.sendMessage(message), STATUS_ACTION))
            : '(not on the extension\'s page)';
        await stop().catch((reason) => console.error(`closing ${browser.name}: ${reason.message}`));
        report([
            [ `${browser.name}: the page`, shown ],
            [ `${browser.name}: the extension's status`, status ],
            [ `${browser.name}: the extension's console`, consoles.join('\n') ],
            [ `host manifests in ${manifestDirectory(browser.name)}`, listOr(manifestDirectory(browser.name)) ],
            [ 'the owner\'s audit', auditText() ],
            [ `${browser.name}'s log, with keypaste's standard error (${log})`, readOr(log) ],
        ]);
        throw error;
    }
    await stop();
};

const runFirefox = async function(app, browser, ports, items) {
    const uuid = crypto.randomUUID();
    const log = path.join(root, 'geckodriver-fill.log');
    let gecko;
    try {
        gecko = await Gecko.start(geckodriver, browserEnvironment, log);
        // Every name resolves to this machine, and the pages' certificate, made for this run, is accepted.
        const capabilities = await gecko.open(browser.executable, uuid, {
            'network.dns.forceResolve': '127.0.0.1',
            'dom.security.https_first': false,
            // LibreWolf turns HTTPS-Only on, which refuses the http page whose fill keypaste must warn about.
            'dom.security.https_only_mode': false,
            'signon.rememberSignons': false,
            'signon.autofillForms': false,
        // LibreWolf's software renderer gets no surface in a headless window on Windows, so it runs in a visible one there.
        }, { acceptInsecureCerts: true, headless: !(browser.name === 'librewolf' && platform === 'win32') });
        console.log(`${browser.name}: ${capabilities.browserVersion}`);
        const installed = await gecko.session('POST', '/moz/addon/install', { path: browser.build, temporary: true });
        if (installed !== FIREFOX_ID) {
            throw new Error(`${browser.name} installed the add-on as ${installed}, not ${FIREFOX_ID}`);
        }
        await gecko.openExtensionPage(`moz-extension://${uuid}/options/options.html`);
        await gecko.waitDisplayed('#paired', false);
        const connect = await gecko.element('#connect-button');
        // A visible LibreWolf on Windows can take a moment to draw its page, and until then nothing in it can be clicked.
        const press = () => until(
            () => gecko.session('POST', `/element/${connect}/click`, {}).then(() => true, (error) => {
                if (!/not interactable/.test(error.message)) {
                    throw error;
                }
                return undefined;
            }),
            `${browser.name} to draw the Connect button`,
            15000);
        await pair(app, browser.identity, press);
        await gecko.waitDisplayed('#paired');
        await fillActs(app, new FirefoxTab(gecko), ports, items, browser.name);
    } catch (error) {
        const shown = gecko?.id
            ? await new FirefoxTab(gecko).state().then(JSON.stringify, (reason) => `(${reason.message})`)
            : '(no session)';
        await gecko?.stop().catch((reason) => console.error(`closing ${browser.name}: ${reason.message}`));
        report([
            [ `${browser.name}: the page`, shown ],
            [ `host manifests in ${manifestDirectory(browser.name)}`, listOr(manifestDirectory(browser.name)) ],
            [ 'the owner\'s audit', auditText() ],
            [ `geckodriver's and Firefox's log, with the add-on's console and keypaste's standard error (${log})`, readOr(log) ],
        ]);
        throw error;
    }
    await gecko.stop();
};

// The browser's keypaste ends when the browser does, so none outlives the run.
const requireNoHostLeft = async function(name) {
    const left = () => {
        const listed = platform === 'win32'
            ? spawnSync('tasklist', [ '/FO', 'CSV', '/NH' ], { encoding: 'utf8' }).stdout
            : spawnSync('ps', [ '-eo', 'args' ], { encoding: 'utf8' }).stdout;
        return listed.split(/\r?\n/).filter((line) => line.includes(keypaste) || (platform === 'win32' && /"keypaste\.exe"/i.test(line)));
    };
    await until(async () => left().length === 0 || undefined, `the keypaste ${name} started to end`, 15000).catch(() => {
        throw new Error(`a keypaste ${name} started is still running: ${left().join(' | ')}`);
    });
};

(async () => {
    const spki = crypto.createHash('sha256')
        .update(new crypto.X509Certificate(fs.readFileSync(settings.cert)).publicKey.export({ type: 'spki', format: 'der' }))
        .digest('base64');
    const ports = await startServers();
    const items = logins(ports);
    addLogins(items);
    fs.mkdirSync(keypasteHome, { recursive: true });

    const app = new HeldApp(driver, vault, ownerEnvironment);
    let code = 0;
    try {
        await app.held();
        for (const browser of browsers) {
            await app.browserOn(browser.name);
            runsFirefoxAddOn(browser.name)
                ? await runFirefox(app, browser, ports, items)
                : await runChromiumFamily(app, browser, ports, items, spki);
            await requireNoHostLeft(browser.name);
            // Turned off again, so the next browser finds only the manifest keypaste writes for it.
            await app.act(`browser-off ${browser.name}`, new RegExp(`^browser-off ${escape(browser.name)}`));
            console.log(`${browser.name} filled and refused as keypaste's rules say`);
        }
        requireAudit(items, ports);
    } catch (error) {
        console.error(`::error::${error.message}`);
        code = 1;
    } finally {
        await app.quit().catch((error) => {
            console.error(`::error::${error.message}`);
            app.process.kill('SIGKILL');
            code = 1;
        });
        await ports.close();
    }
    process.exit(code);
})();
