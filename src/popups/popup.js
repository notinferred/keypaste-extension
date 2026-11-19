'use strict';

const REDETECT_RESULT_MS = 4000;

const VIEWS = [ '#initial-state', '#not-configured', '#need-reconfigure', '#checking-keypaste', '#configured-and-associated',
    '#keypaste-unreachable', '#error-encountered', '#database-not-opened' ];

// Shows one view and names its state in the header, with the pairing's name after it while paired.
function showView(view, state, detail = '') {
    for (const selector of VIEWS) {
        $(selector).hidden = selector !== view;
    }

    $('#state').textContent = state;
    $('#state-detail').textContent = detail ? ` · ${detail}` : '';
    $('#lock-database-button').classList.toggle('concealed', view !== '#configured-and-associated');
}

function statusResponse(r, pairingFailed = false) {
    $('#pairing-failed').hidden = !pairingFailed;
    $('#iframe-detected').hidden = !r.iframeDetected;
    $('#error-problem').title = r.error ?? '';

    if (!r.keypasteAvailable || r.error === tr('errorMessageTimeout')) {
        showView('#keypaste-unreachable', tr('errorNotConnected'));
    } else if (r.databaseClosed) {
        showView('#database-not-opened', tr('stateLocked'));
    } else if (!r.configured) {
        showView('#not-configured', tr('stateNotPaired'));
    } else if (r.encryptionKeyUnrecognized || !r.associated) {
        showView('#need-reconfigure', tr('stateNotPaired'));
    } else if (r.error) {
        showView('#error-encountered', tr('loginListRefused'));
    } else {
        showView('#configured-and-associated', tr('statePaired'), r.identifier);
    }
}

// Re-runs field detection in every frame of the tab and says how many login fields it found.
const redetectFields = async function() {
    const tab = await getCurrentTab();
    if (!tab) {
        return;
    }

    const frames = await browser.webNavigation.getAllFrames({ tabId: tab.id });
    const counts = await Promise.all(frames.map(frame =>
        browser.tabs.sendMessage(tab.id, { action: 'redetect_fields' }, { frameId: frame.frameId }).catch(() => 0)));
    const found = counts.reduce((sum, count) => sum + (count ?? 0), 0);

    const result = $('#redetect-result');
    result.textContent = found === 0 ? tr('popupRedetectNone') : found === 1 ? tr('popupRedetectFoundOne') : tr('popupRedetectFound', [ found ]);
    clearTimeout(result.timeout);
    result.timeout = setTimeout(() => (result.textContent = ''), REDETECT_RESULT_MS);
};

// Shows the code keypaste shows too while it asks the person, then what pairing came to.
const connect = async function() {
    const { code } = await browser.runtime.sendMessage({ action: 'begin_pairing' });
    $('#pairing-code').textContent = code;
    showView('#checking-keypaste', tr('statePairing'));

    const result = await browser.runtime.sendMessage({ action: 'associate' });
    statusResponse(await browser.runtime.sendMessage({ action: 'get_status' }), result === AssociatedAction.NOT_ASSOCIATED);
};

(async () => {
    showView('#initial-state', tr('popupTitle'));
    $('#connect-button').addEventListener('click', connect);

    $('#reconnect-button').addEventListener('click', connect);

    for (const button of document.querySelectorAll('.reload-status-button')) {
        button.addEventListener('click', async () => {
            statusResponse(await browser.runtime.sendMessage({
                action: 'reconnect'
            }));
        });
    }

    $('#reopen-database-button').addEventListener('click', async () => {
        statusResponse(await browser.runtime.sendMessage({
            action: 'get_status',
            args: [ false, true ] // Set forcePopup to true
        }));
        window.close();
    });

    $('#redetect-fields-button').addEventListener('click', redetectFields);

    $('#lock-database-button').addEventListener('click', async () => {
        statusResponse(await browser.runtime.sendMessage({
            action: 'lock_database'
        }));
    });

    statusResponse(await browser.runtime.sendMessage({
        action: 'get_status'
    }).catch((err) => {
        logError('Could not get status: ' + err);
    }));
})();
