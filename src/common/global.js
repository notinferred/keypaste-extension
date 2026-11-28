'use strict';

const EXTENSION_NAME = 'keypaste';

// Credential sorting options
const SORT_BY_TITLE = 'sortByTitle';
const SORT_BY_USERNAME = 'sortByUsername';
const SORT_BY_GROUP_AND_TITLE = 'sortByGroupAndTitle';
const SORT_BY_GROUP_AND_USERNAME = 'sortByGroupAndUsername';
const SORT_BY_MATCHING_CREDENTIALS_SETTING = 'sortByMatchingCredentials';
const SORT_BY_RELEVANT_ENTRY = 'sortByRelevantEntry';

const URL_WILDCARD = '1kpxcwc1';

const AssociatedAction = {
    NOT_ASSOCIATED: 0,
    ASSOCIATED: 1,
    NEW_ASSOCIATION: 2,
    CANCELED: 3
};

const ManualFill = {
    NONE: 0,
    BOTH: 2
};

const TILE_HUES = 7;

// The desktop folds a UUID's bytes in .NET's Guid order, whose first three fields are little-endian, so a login takes the same hue in both.
const GUID_BYTE_ORDER = [ 3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15 ];

// Which of DESIGN's seven tile hues, from 1, a login takes from its UUID's 32 hex digits.
const tileHue = function(uuid = '') {
    const bytes = (uuid.match(/[0-9a-f]{2}/gi) ?? []).map(pair => parseInt(pair, 16));
    const ordered = bytes.length === 16 ? GUID_BYTE_ORDER.map(i => bytes[i]) : bytes;
    const folded = ordered.reduce((sum, byte) => (Math.imul(sum, 31) + byte) >>> 0, 0);
    return (folded % TILE_HUES) + 1;
};

// The first letter or digit of a title, as the tile shows it.
const tileLetter = function(title = '') {
    return (title.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
};

const isFirefox = function() {
    return browser.runtime.getURL('')?.startsWith('moz-extension');
};

const isSafari = function() {
    return browser.runtime.getURL('')?.startsWith('safari-web-extension');
};

// Returns a string with 'px' for CSS styles
const Pixels = function(value) {
    return String(value) + 'px';
};

// Checks if element's nodeName matches
const matchesWithNodeName = function(elem, name) {
    // Don't allow undefined element or 'name'
    if (!elem || !name) {
        return false;
    }

    return elem?.nodeName?.toUpperCase() === name?.toUpperCase();
};

// Match hostname or path with wildcards
const matchWithRegex = function(firstUrlPart, secondUrlPart, hostnameUsed = false) {
    if (firstUrlPart === secondUrlPart) {
        return true;
    }

    // If there's no wildcard with hostname, just compare directly
    if (hostnameUsed && !firstUrlPart.includes(URL_WILDCARD) && firstUrlPart !== secondUrlPart) {
        return false;
    }

    // Escape illegal characters
    let re = firstUrlPart.replaceAll(/[!\^$\+\-\(\)@<>]/g, '\\$&');
    if (hostnameUsed) {
        // Replace all host parts with wildcards so e.g. https://*.example.com is accepted with https://example.com
        re = re.replaceAll(`${URL_WILDCARD}.`, '(.*?)');
    }

    // Replace any remaining wildcards for paths
    re = re.replaceAll(URL_WILDCARD, '(.*?)');

    return secondUrlPart.match(new RegExp(re));
};

// Matches a site pattern, such as a predefined site's, with the current URL
const siteMatch = function(site, url) {
    try {
        site = site.replaceAll('*', URL_WILDCARD);
        const siteUrl = new URL(site);
        const currentUrl = new URL(url);

        // Match scheme and port. If the pattern does not use a port, all ports are ignored.
        if (siteUrl.protocol !== currentUrl.protocol || (siteUrl.port && siteUrl.port !== currentUrl.port)) {
            return false;
        }

        // Match hostname and path
        if (!matchWithRegex(siteUrl.hostname, currentUrl.hostname, true)
            || !matchWithRegex(siteUrl.pathname, currentUrl.pathname)) {
            return false;
        }

        return true;
    } catch(e) {
        logError(e);
    }

    return false;
};

function tr(key, params) {
    return browser.i18n.getMessage(key, params);
}

const debugLogMessage = function(message, extra) {
    console.debug(`[Debug ${getFileAndLine()}] ${EXTENSION_NAME} - ${message}`);

    if (extra) {
        console.debug(extra);
    }
};

const logError = function(message) {
    console.log(`[Error ${getFileAndLine()}] ${EXTENSION_NAME} - ${message}`);
};

// Returns file name and line number from error stack
const getFileAndLine = function() {
    const err = new Error().stack.split('\n');
    const line = err[4] ?? err.at(-1);
    const result = line.substring(line.lastIndexOf('/') + 1, line.lastIndexOf(':'));

    return result;
};

const getCurrentTab = async function() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs?.length > 0 ? tabs[0] : undefined;
};

// Check if element b is inside a
const isElementInside = (a, b) => (b.x >= a.x && b.right <= a.right) && (b.y >= a.y && b.bottom <= a.bottom);

// Check if two elements overlap
const elementsOverlap = function(rect1, rect2) {
    const overlaps = (a, b) => !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
    return isElementInside(rect1, rect2) || overlaps(rect1, rect2);
};

// What keypaste's owner can do beyond 1.0.0, as it advertises in its answer to a pairing or its check; with none, the extension does as 1.0.0 did.
const Feature = Object.freeze({
    FILL: 'fill',
    CONTINUED: 'continued',
    FRAMES: 'frames',
    TOTP: 'totp',
});

// The parts of a login one fill can release.
const FillPart = Object.freeze({
    USERNAME: 'username',
    PASSWORD: 'password',
    BOTH: 'both',
    TOTP: 'totp',
});

// The origin of an address, or '' for one that is not a URL.
const originOf = function(url) {
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
};

// What a pick asks keypaste to release: only the fields the page shows, so a username-only page gets no password.
const fillFor = function(usernameShown, passwordShown) {
    if (usernameShown && !passwordShown) {
        return FillPart.USERNAME;
    }

    return passwordShown && !usernameShown ? FillPart.PASSWORD : FillPart.BOTH;
};

/**
 * The addresses a request about a frame's logins carries, both as the browser reports them and never as the page says: the tab's
 * for a frame of the tab's origin; the frame's own with the tab's as topUrl for an https frame of another origin, when keypaste
 * decides frames; and null for any other frame, which keypaste is never asked about.
 * @param {string} tabUrl       The tab's address
 * @param {string} frameUrl     The asking frame's address, or '' for the tab's own document
 * @param {string} frameOrigin  The frame's origin as the browser reports it, 'null' for a sandboxed frame, or '' when it gives none
 * @param {Array} features      What keypaste advertised
 * @returns {object|null}       { url } or { url, topUrl }, or null
 */
const frameRequest = function(tabUrl, frameUrl, frameOrigin, features = []) {
    const tabOrigin = originOf(tabUrl);
    if (!tabOrigin || tabOrigin === 'null') {
        return null;
    }

    const origin = frameUrl ? originOf(frameUrl) : tabOrigin;
    if (origin === tabOrigin && frameOrigin !== 'null') {
        return { url: tabUrl };
    }

    if (!features.includes(Feature.FRAMES) || frameOrigin === 'null' || !origin.startsWith('https://')) {
        return null;
    }

    return { url: frameUrl, topUrl: tabUrl };
};

// Whether a page of this host may continue a fill keypaste bound to a registrable domain.
const continuesOn = function(host, site) {
    if (!host || !site) {
        return false;
    }

    const lowered = host.toLowerCase();
    return lowered === site || lowered.endsWith(`.${site}`);
};

// Exports for tests
if (typeof module === 'object') {
    module.exports = {
        continuesOn,
        elementsOverlap,
        fillFor,
        frameRequest,
        matchesWithNodeName,
        siteMatch,
        tileHue,
        tileLetter,
    };
}
