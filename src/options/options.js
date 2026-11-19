'use strict';

// A day other than today as its date, and a time today as Today and its hour and minute.
const formatTime = function(time, now = new Date()) {
    const date = new Date(time);
    if (date.toDateString() === now.toDateString()) {
        return tr('optionsToday', [ date.toLocaleTimeString(undefined, { timeStyle: 'short' }) ]);
    }

    return date.toLocaleDateString(undefined, { dateStyle: 'medium' });
};

const showPairing = async function() {
    const pairing = await browser.runtime.sendMessage({ action: 'get_pairing' });
    document.getElementById('paired').hidden = !pairing;
    document.getElementById('not-paired').hidden = Boolean(pairing);
    document.getElementById('connect-actions').hidden = Boolean(pairing);

    if (pairing) {
        document.getElementById('pairing-name').textContent = pairing.id;
        document.getElementById('paired-at').textContent = formatTime(pairing.created);
        document.getElementById('last-used').textContent = formatTime(pairing.lastUsed);
    }
};

(async () => {
    document.getElementById('version').textContent = browser.runtime.getManifest().version;

    document.getElementById('connect-button').addEventListener('click', async () => {
        const { code } = await browser.runtime.sendMessage({ action: 'begin_pairing' });
        document.getElementById('pairing-code').textContent = code;
        document.getElementById('pairing-check').hidden = false;
        document.getElementById('connect-actions').hidden = true;
        document.getElementById('connect-result').hidden = true;

        const result = await browser.runtime.sendMessage({ action: 'associate' });
        document.getElementById('pairing-check').hidden = true;
        document.getElementById('connect-result').hidden = result !== AssociatedAction.NOT_ASSOCIATED;
        await showPairing();
    });

    await showPairing();
})();
