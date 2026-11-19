'use strict';

(async () => {
    const tab = await getCurrentTab();
    if (!tab) {
        return [];
    }

    const pairing = await browser.runtime.sendMessage({ action: 'get_pairing' });
    $('#state-detail').textContent = pairing ? ` · ${pairing.id}` : '';
    $('#login-site').textContent = new URL(tab.url).hostname;

    const logins = await getLoginData();
    const list = document.getElementById('login-list');

    for (const [ i, login ] of logins.entries()) {
        const button = createLoginButton(login);
        button.addEventListener('click', (e) => {
            if (!e.isTrusted) {
                return;
            }

            browser.tabs.sendMessage(tab?.id, {
                action: 'fill_user_pass_with_specific_login',
                id: i,
                uuid: login.uuid
            });

            close();
        });

        const item = document.createElement('li');
        item.dataset.search = login.text.toLowerCase();
        item.append(button);
        list.append(item);
    }

    list.hidden = logins.length === 0;
    $('#no-logins').hidden = logins.length > 0;

    if (logins.length > 1) {
        $('#filter-block').hidden = false;
        const filter = document.getElementById('login-filter');
        const clear = document.getElementById('clear-filter');
        const applyFilter = () => {
            const query = filter.value.toLowerCase();
            clear.hidden = query === '';
            for (const item of list.children) {
                item.hidden = !item.dataset.search.includes(query);
            }
        };

        filter.addEventListener('input', (e) => {
            if (e.isTrusted) {
                applyFilter();
            }
        });

        clear.addEventListener('click', () => {
            filter.value = '';
            applyFilter();
            filter.focus();
        });

        filter.focus();
    }

    $('#new-login-button').addEventListener('click', () => {
        browser.runtime.sendMessage({ action: 'open_keypaste', args: [ 'new-login', '' ] });
        close();
    });

    $('#lock-database-button').addEventListener('click', (e) => {
        browser.runtime.sendMessage({
            action: 'lock_database'
        });

        $('#credentialsList').hidden = true;
        $('#database-not-opened').hidden = false;
        $('#lock-database-button').classList.add('concealed');
        $('#state').textContent = tr('stateLocked');
        $('#state-detail').textContent = '';
    });

    $('#reopen-database-button').addEventListener('click', (e) => {
        browser.runtime.sendMessage({
            action: 'get_status',
            args: [ false, true ] // Set forcePopup to true
        });
    });
})();

// A login as both lists draw it: its tile, its title over its username, and its vault while several vaults answer.
function createLoginButton(login) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'login';

    const tile = document.createElement('span');
    tile.className = 'tile';
    tile.setAttribute('aria-hidden', 'true');
    tile.style.background = `var(--kp-tile-${tileHue(login.uuid)})`;
    tile.textContent = tileLetter(login.title ?? login.text);

    const names = document.createElement('span');
    names.className = 'login-names';
    const title = document.createElement('span');
    title.className = 'login-title';
    title.textContent = login.title ?? login.text;
    names.append(title);

    if (login.username !== undefined) {
        const username = document.createElement('span');
        username.className = 'login-username';
        username.textContent = login.expired ? `${login.username} · ${tr('credentialExpired')}` : login.username;
        names.append(username);
    }

    button.append(tile, names);
    if (login.vault) {
        const vault = document.createElement('span');
        vault.className = 'login-vault';
        vault.textContent = login.vault;
        button.append(vault);
    }

    return button;
}
