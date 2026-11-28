'use strict';

const Tests = {
    GENERAL: '#general-results',
    INPUT_FIELDS: '#input-field-results',
    SEARCH_FIELDS: '#search-field-results',
    TOTP_FIELDS: '#totp-field-results',
    FILL_SHORTCUT: '#fill-shortcut-results',
};

function createResult(card, res, text) {
    const icon = kpxcUI.createElement('i', res ? 'fa fa-check' : 'fa fa-close', { id: text });
    const span = kpxcUI.createElement('span', '', '', text);
    const br = document.createElement('br');

    document.querySelector(card).appendMultiple(icon, span, br);
}

// Input field matching (keypaste.js)
async function testInputFields() {
    // Div ID, expected fields, action element ID (a button to be clicked)
    const testDivs = [
        [ 'basic1', 2 ], // Username/passwd fields
        [ 'basic2', 1 ], // Only username field
        [ 'basic3', 1 ], // Only password field
        [ 'basic4', 3 ], // Username/passwd/one more text field
        [ 'div1', 2, '#toggle1' ], // Fields are behind a button that must be pressed
        [ 'div2', 2, '#toggle2' ], // Fields are behind a button that must be pressed behind a JavaScript
        //[ 'div3', 2, '#toggle3' ], // Fields are behind a button that must be pressed
        //[ 'div4', 2, '#toggle4' ], // Fields are behind a button that must be pressed
        [ 'hiddenFields1', 0 ], // Two hidden fields
        //[ 'hiddenFields2', 1 ], // Two hidden fields with one visible
    ];

    for (const div of testDivs) {
        await assertInputFields(div[0], div[1], div[2]);
    }
}

// Search fields (kpxcFields
async function testSearchFields() {
    const searchFields = [
        [ '', { id: 'otp_field', name: 'otp', type: 'text', maxLength: '8' }, 'Generic 2FA field', false ],
        [ '', { placeholder: 'search', type: 'text', id: 'username' }, 'Placeholder only', true ],
        [ '', { ariaLabel: 'search', type: 'text', id: 'username' }, 'aria-label only', true ],

    ];

    for (const field of searchFields) {
        assertSearchField(field[0], field[1], field[2], field[3]);
    }

    assertSearchForm({ id: 'username', type: 'text', }, 'Generic input field under search form', true);
}

// One-time code fields (kpxcFields.isOneTimeCodeField), upstream's TOTP field cases
async function testOneTimeCodeFields() {
    const fields = [
        [ '', { id: 'otp_field', name: 'otp', type: 'text', maxLength: '8' }, 'Generic 2FA field', true ],
        [ '', { id: '2fa', type: 'text', maxLength: '6' }, 'Generic 2FA field', true ],
        [ '', { id: '2fa', type: 'text', maxLength: '4' }, 'Ignore if field maxLength too small', false ],
        [ '', { id: '2fa', type: 'text', maxLength: '12' }, 'Ignore if field maxLength too long', false ],
        [ '', { id: 'promocode', type: 'text', }, 'promocode id is not acceptable', false ],
        [ '', { id: 'Promotional Code', type: 'text', }, 'Promotional Code id is not acceptable', false ],
        [ '', { id: 'postcode', type: 'text', }, 'postcode id is not acceptable', false ],
        [ '', { id: 'postalcode', type: 'text', }, 'postalcode id is not acceptable', false ],
        [ '', { id: 'encode', type: 'text', }, 'encode id is not acceptable', false ],
        [ '', { id: 'encodedText', type: 'text', }, 'encodedText is not acceptable', false ],
        [ '', { id: 'decoder', type: 'text', }, 'decoder id is not acceptable', false ],
        [ '', { id: 'code', type: 'text', }, 'code id is accepted', true ],
        [ '', { id: '2fa', type: 'text', maxLength: '12', autocomplete: 'one-time-code' }, 'Accept if one-time-code', true ],
        [ '', { id: 'username', type: 'text', }, 'Ignore a generic input field', false ],
        [ '', { type: 'password', }, 'Ignore a password input field', false ],
        [ '', { id: 'email', name: 'email', type: 'email' }, 'Ignore an email field', false ],
        [ // Protonmail
            'TwoFA-input ng-empty ng-invalid ng-invalid-required ng-valid-minlength ng-valid-maxlength ng-touched',
            { autocapitalize: 'off', autocorrect: 'off', id: 'twoFactorCode', type: 'text', placeholder: 'Two-factor passcode', name: 'twoFactorCode' },
            'Protonmail 2FA',
            true
        ],
        [ // Nextcloud
            '',
            { minlength: '6', maxLength: '10', name: 'challenge', placeholder: 'Authentication code', type: 'tel', },
            'Nextcloud 2FA',
            true
        ],
        [ // GMail
            'whsOnd zHQkBf',
            { autocomplete: 'off', id: 'idvPin', tabindex: '0', name: 'idvPin', pattern: '[0-9 ]*', type: 'tel', spellcheck: 'false' },
            'GMail 2FA',
            true
        ],
        [ // Live.com
            'form-control',
            { autocomplete: 'off', id: 'idTxtBx_SAOTCC_OTC', maxLength: '8', tabindex: '0', name: 'otc', placeholder: 'Code', type: 'tel' },
            'Live.com 2FA',
            true
        ],
    ];

    for (const field of fields) {
        assertOneTimeCodeField(field[0], field[1], field[2], field[3]);
    }
}

// The fill shortcut (keypaste.js): the list opens in the field with the focus, or else in the page's first login field
async function testFillShortcut() {
    const input = (id, type = 'text') => `<input id="${id}" type="${type}" style="display:block;width:200px;height:30px">`;
    const combination = (username, password) => ({ username, password, passwordInputs: password ? [ password ] : [], form: null });
    const byId = (id) => document.getElementById(id);
    const loginForm = (id) => combination(byId(`${id}-user`), byId(`${id}-pass`));

    // Fixture markup, the page's combinations, the field focused before the shortcut, and the field the list opens in
    const cases = [
        [ input('a-user') + input('a-pass', 'password'), () => [ loginForm('a') ], null, 'a-user', 'No field focused opens in the username' ],
        [ input('b-pass', 'password'), () => [ combination(null, byId('b-pass')) ], null, 'b-pass', 'No username field opens in the password' ],
        [ '<input id="c-user" style="display:none">' + input('c-pass', 'password'), () => [ loginForm('c') ], null, 'c-pass',
            'A hidden username opens in the password' ],
        [ input('d-user') + input('d-pass', 'password') + input('e-user') + input('e-pass', 'password'),
            () => [ loginForm('e'), loginForm('d') ], null, 'd-user', 'The first form in the page wins whatever the detection order' ],
        [ input('f-user') + input('f-pass', 'password') + input('f-other'), () => [ loginForm('f') ], 'f-other', 'f-other',
            'A focused field keeps the list' ],
        [ input('g-code'), () => [ { username: null, password: null, passwordInputs: [], totp: byId('g-code'), form: null } ], null, undefined,
            'A one-time code field alone opens nothing' ],
        [ input('h-search'), () => [], null, undefined, 'A page without login fields opens nothing' ],
    ];

    const fixture = kpxcUI.createElement('div', '', { id: 'shortcut-fixture' });
    fixture.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;background:white;padding:8px';
    document.body.appendChild(fixture);
    const combinations = kpxc.combinations;

    try {
        for (const [ markup, combine, focusId, expectedId, testName ] of cases) {
            fixture.innerHTML = markup;
            kpxc.combinations = combine();
            document.activeElement?.blur();
            if (focusId) {
                byId(focusId).focus();
            }

            kpxcAssert(kpxc.shortcutField()?.id, expectedId, Tests.FILL_SHORTCUT, testName);
        }

        // Focus in a frame of the page: that frame answers the shortcut, and this document opens nothing
        fixture.innerHTML = input('i-user') + '<iframe id="i-frame" srcdoc="<input>"></iframe>';
        kpxc.combinations = [ combination(byId('i-user'), null) ];
        await new Promise(resolve => byId('i-frame').addEventListener('load', resolve, { once: true }));
        byId('i-frame').contentDocument.querySelector('input').focus();
        kpxcAssert(kpxc.shortcutField(), undefined, Tests.FILL_SHORTCUT, 'Focus in a frame leaves the page\'s list closed');
    } finally {
        kpxc.combinations = combinations;
        fixture.remove();
    }
}

// Run tests
(async () => {
    await Promise.all([
        await testInputFields(),
        await testSearchFields(),
        await testOneTimeCodeFields(),
        await testFillShortcut(),
    ]);
})();
