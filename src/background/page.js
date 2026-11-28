'use strict';

// keypaste decides these; the extension offers no settings of its own.
const defaultSettings = {
    afterFillSorting: SORT_BY_MATCHING_CREDENTIALS_SETTING,
    autoCompleteUsernames: true,
    autoFillSingleEntry: false,
    autoFillRelevantCredential: false,
    autoSubmit: false,
    clearCredentialsTimeout: 10,
    credentialSorting: SORT_BY_GROUP_AND_TITLE,
    debugLogging: false,
    showGroupNameInAutocomplete: true,
    showLoginFormIcon: true,
    showNotifications: true,
    useCompactMode: false,
    useObserver: true,
    usePredefinedSites: true,
};

const AUTO_SUBMIT_TIMEOUT = 5000;

// keypaste continues a fill only within the window it names; this caps what an answer may name.
const LONGEST_CONTINUATION_SECONDS = 120;

/**
 * @Object page
 * Handles information between background and content scripts.
 */
const page = {};
page.autoSubmitPerformed = false;
// Per tab, the fill keypaste said the next click may continue: { uuid, site, until, filled }; never a value.
page.continuations = new Map();
page.currentRequest = {};
page.isFirefox = false;
page.manualFill = ManualFill.NONE;
page.menuContexts = [ 'editable' ];
page.passwordFilled = false;
page.settings = Object.freeze({ ...defaultSettings });

page.popupData = {
    iconType: 'normal',
    popup: 'popup'
};

page.initBrowser = async function() {
    page.isFirefox = isFirefox();
};

page.getSettings = async function() {
    return page.settings;
};

page.clearCredentials = async function(tabId, complete) {
    if (!tabs.getTabFromId(tabId)) {
        return;
    }

    page.passwordFilled = false;
    tabs.updateTabValues(tabId, { credentials: [] });

    if (complete) {
        page.clearLogins(tabId);

        browser.tabs.sendMessage(tabId, {
            action: 'clear_credentials'
        }).catch((e) => {});
    }
};

page.clearLogins = async function(tabId) {
    const currentTab = tabs.getTabFromId(tabId);
    if (!currentTab) {
        return;
    }

    tabs.updateTabValues(tabId, {
        credentials: [],
        loginList: []
    });

    page.currentRequest = {};
    page.passwordFilled = false;
};

// Clear all logins from all pages and update the content scripts
page.clearAllLogins = function() {
    page.continuations.clear();
    tabs.tabList.forEach((_tab, key) => {
        page.clearCredentials(Number(key), true);
    });
};

// The addresses a frame's request carries, from the browser's tab and the browser's word for the frame, never the page's.
const requestOf = async function(tab, sender) {
    // A message from a frame in another process can come without its tab's address, which the browser still gives by the tab's ID.
    const tabUrl = tab?.url ?? (tab?.id ? await browser.tabs.get(tab.id).then((found) => found?.url).catch(() => undefined) : undefined);
    const request = frameRequest(tabUrl, sender?.url ?? '', sender?.origin ?? '', keepass.features);
    if (!request && sender?.url && originOf(sender.url) !== originOf(tabUrl)) {
        logError(`A frame of ${originOf(sender.url) || 'no origin'} (the browser says ${sender?.origin ?? 'nothing'}) on ${originOf(tabUrl) || 'no address'} is not asked about; keypaste offers ${keepass.features.join(', ') || 'nothing beyond 1.0.0'}.`);
    }

    return request;
};

// As requestOf, having first asked keypaste what it advertises when nothing told the extension yet, as after the worker starts.
const freshRequestOf = async function(tab, sender) {
    const request = await requestOf(tab, sender);
    if (request || keepass.features.length > 0 || !keepass.isConnected) {
        return request;
    }

    await keepass.testAssociation(tab, [ false, false ]);
    return await requestOf(tab, sender);
};

// The names of the page's logins, the site taken from the browser's tab and never from the page.
page.listLogins = async function(tab, args = [], sender) {
    const request = await freshRequestOf(tab, sender);
    if (!request) {
        return { state: 'frame' };
    }

    const [ submitUrl ] = args;
    const answer = await keepass.listLogins(tab, [ request.url, submitUrl, request.topUrl ]);
    return { ...answer, site: answer.site || new URL(request.url).hostname };
};

// The one login the person picked in the list, releasing only the parts the page shows when keypaste can.
page.fillLogin = async function(tab, args = [], sender) {
    const request = await requestOf(tab, sender);
    if (!request) {
        return {};
    }

    const [ uuid, submitUrl, fill ] = args;
    const login = await keepass.getLogin(tab, [ request.url, submitUrl, uuid, { fill, topUrl: request.topUrl } ]);
    page.keepContinuation(tab, login, [ fill ?? FillPart.BOTH ]);
    return login;
};

// The next part of the tab's last fill, with no list and no pick, while keypaste said it may continue on this page; null otherwise.
page.continueLogin = async function(tab, args = [], sender) {
    const request = await requestOf(tab, sender);
    const continuation = page.continuations.get(tab?.id);
    const [ part, submitUrl ] = args;
    if (!request || !continuation || !keepass.features.includes(Feature.CONTINUED)) {
        return null;
    }

    if (Date.now() > continuation.until || !continuesOn(new URL(request.url).hostname, continuation.site)) {
        page.continuations.delete(tab.id);
        return null;
    }

    if (![ FillPart.PASSWORD, FillPart.TOTP, FillPart.USERNAME ].includes(part) || continuation.filled.includes(part)
        || (part === FillPart.TOTP && !keepass.features.includes(Feature.TOTP))) {
        return null;
    }

    const login = await keepass.getLogin(tab, [ request.url, submitUrl, continuation.uuid, { fill: part, continued: true, topUrl: request.topUrl } ]);
    if (login?.uuid !== continuation.uuid) {
        return null;
    }

    page.keepContinuation(tab, login, [ ...continuation.filled, part ]);
    return login;
};

// Keeps, for the tab, what keypaste said the next click may continue after a fill, or forgets it when nothing continues.
page.keepContinuation = function(tab, login, filled) {
    if (!tab?.id) {
        return;
    }

    const seconds = Math.min(login?.continueSeconds ?? 0, LONGEST_CONTINUATION_SECONDS);
    if (!login?.uuid || !login.continueSite || seconds <= 0) {
        page.continuations.delete(tab.id);
        return;
    }

    const parts = filled.flatMap(part => part === FillPart.BOTH ? [ FillPart.USERNAME, FillPart.PASSWORD ] : [ part ]);
    page.continuations.set(tab.id, { uuid: login.uuid, site: login.continueSite, until: Date.now() + (seconds * 1000), filled: parts });
};

// A tab that moved to another site, or closed, continues nothing.
page.forgetContinuation = function(tabId, url) {
    const continuation = page.continuations.get(tabId);
    if (!continuation) {
        return;
    }

    let host = '';
    try {
        host = url ? new URL(url).hostname : '';
    } catch {
        // Not an address: nothing continues there.
    }

    if (!continuesOn(host, continuation.site)) {
        page.continuations.delete(tabId);
    }
};

page.openKeypaste = async function(tab, args = []) {
    return await keepass.openKeypaste(tab, args);
};

page.getLoginId = async function(tab, returnSingle = true) {
    // If there's only one credential available and loginId is not set
    const currentTab = tabs.getTabFromId(tab.id);
    if (currentTab && returnSingle && !currentTab.loginId && currentTab.credentials.length === 1) {
        return currentTab.credentials[0].uuid;
    }

    return currentTab ? currentTab.loginId : undefined;
};

page.setLoginId = async function(tab, loginId) {
    tabs.updateTabValues(tab?.id, { loginId: loginId });
};

page.getManualFill = async function(tab) {
    return page.manualFill;
};

page.setManualFill = async function(tab, manualFill) {
    page.manualFill = manualFill;
};

page.getAutoSubmitPerformed = async function(tab) {
    return page.autoSubmitPerformed;
};

// Set autoSubmitPerformed to false after 5 seconds, preventing possible endless loops
page.setAutoSubmitPerformed = async function(tab) {
    if (!page.autoSubmitPerformed) {
        page.autoSubmitPerformed = true;

        setTimeout(() => {
            page.autoSubmitPerformed = false;
        }, AUTO_SUBMIT_TIMEOUT);
    }
};

// Returns login list for the extension popup
page.getLoginList = async function(tab) {
    return tabs.getTabFromId(tab.id)?.loginList ?? [];
};

// Whether the asking frame may ask keypaste at all: the tab's own origin, or, when keypaste decides frames, an https frame that is not sandboxed.
page.isIframeAllowed = async function(tab, args = [], sender) {
    return await freshRequestOf(tab, sender) !== null;
};

const logDebug = function(message, extra) {
    if (page.settings.debugLogging) {
        debugLogMessage(message, extra);
    }
};
