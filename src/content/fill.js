'use strict';

/**
 * @Object kpxcFill
 * The class for filling credentials.
 */
const kpxcFill = {};

// What a field's form shows, and so what a pick there asks keypaste to release: the one-time code in its field, otherwise the visible fields.
kpxcFill.partFor = function(combination, field) {
    if (combination?.totp && (!field || combination.totp === field)) {
        return FillPart.TOTP;
    }

    const shown = (input) => Boolean(input) && kpxcFields.isVisible(input);
    return fillFor(shown(combination?.username), shown(combination?.password));
};

// The one login the person picked, asked of keypaste for the tab's address and filled into the field's form; nothing is kept.
kpxcFill.fillPicked = async function(combination, uuid, field) {
    if (!combination || !uuid) {
        return;
    }

    const part = kpxcFill.partFor(combination, field);
    const login = await sendMessage('fill_login', [ uuid, kpxc.submitUrl, part ]);
    if (login?.uuid !== uuid) {
        const words = login?.locked ? 'loginListKeypasteLocked' : part === FillPart.TOTP ? 'loginListCodeNotFilled' : 'loginListNotFilled';
        kpxcUI.createNotification('warning', tr(words));
        return;
    }

    await sendMessage('page_set_login_id', uuid);
    await kpxcFill.fillLogin(combination, login);
};

/**
 * Fills the next part of the tab's last fill into the clicked field, with no list and no pick, when keypaste continues it here.
 * @param {HTMLElement} field   The field whose key icon was clicked
 * @returns {boolean}           Whether it filled; otherwise the list opens as usual
 */
kpxcFill.fillContinued = async function(field) {
    if (!kpxc.features.includes(Feature.CONTINUED)) {
        return false;
    }

    const combination = await kpxcFields.getCombination(field);
    const part = combination?.totp === field ? FillPart.TOTP : combination?.password === field ? FillPart.PASSWORD : undefined;
    if (!part) {
        return false;
    }

    const login = await sendMessage('continue_login', [ part, kpxc.getFormActionUrl(combination) ]);
    if (!login?.uuid) {
        return false;
    }

    await kpxcFill.fillLogin(combination, login);
    return true;
};

// Picked in the toolbar's login popup, the extension's own page
kpxcFill.fillFromPopup = async function(uuid) {
    if (kpxc.combinations.length === 0) {
        logDebug('Error: No login fields on this page.');
        return;
    }

    await kpxcFill.fillPicked(kpxcFields.getCombinationFromAllInputs(), uuid);
};

/**
 * Fills one released login into a form
 * @param {Object} combination  The form's username and password fields
 * @param {Object} login        The login keypaste released: login, password, name and uuid
 */
kpxcFill.fillLogin = async function(combination, login) {
    const usernameValue = login.login;

    // A one-time code goes only into its own field; keypaste releases nothing else with it.
    if (login.totp) {
        if (combination.totp) {
            await kpxcFill.setValueWithChange(combination.totp, login.totp);
        }
        kpxcUserAutocomplete.closeList();
        return;
    }

    // Additional checks
    checkIdenticalPasswordFields(combination);
    checkReadOnlyUsernameField(combination);

    if (combination.password && login.password && matchesWithNodeName(combination.password, 'INPUT')) {
        // Show a notification if password length exceeds the length defined in input
        if (combination.password.maxLength
            && combination.password.maxLength > 0
            && login.password.length > combination.password.maxLength) {
            kpxcUI.createNotification('warning', tr('errorMessagePaswordLengthExceeded'));
        }

        await kpxcFill.setValueWithChange(combination.password, login.password);
        await kpxc.setPasswordFilled(true);
    }

    if (combination.username && usernameValue && combination.username !== combination.password &&
        (!combination.username.value || combination.username.value !== usernameValue)) {
        await kpxcFill.setValueWithChange(combination.username, usernameValue);
    }

    kpxcUserAutocomplete.closeList();
    await kpxcFill.performAutoSubmit(combination, false);
};

// Performs Auto-Submit. If filling single credentials is enabled, a 5 second timeout will be needed for fill
kpxcFill.performAutoSubmit = async function(combination, skipAutoSubmit) {
    if (!kpxc.settings.autoSubmit) {
        return;
    }

    const isAutoSubmitPerformed = await sendMessage('page_get_autosubmit_performed');
    if (isAutoSubmitPerformed && kpxc.settings.autoFillSingleEntry) {
        return;
    }

    if (!skipAutoSubmit) {
        await sendMessage('page_set_autosubmit_performed');

        const submitButton = kpxcForm.getFormSubmitButton(combination.form);
        if (submitButton !== undefined) {
            submitButton.click();
        } else if (combination.form) {
            combination.form.submit();
        }
    } else {
        (combination.username || combination.password).focus();
    }
};

// Sets a new value to input field and triggers necessary events
kpxcFill.setValueWithChange = async function(field, value) {
    if (!field || field?.readOnly) {
        return;
    }

    // Check for overlays before fill
    kpxcFields.discoverOverlays();
    const rect = field.getBoundingClientRect();
    if (kpxcFields.isOverlayOnTop(rect)) {
        return;
    }

    const dispatchLegacyEvent = function(elem, eventName) {
        const legacyEvent = elem.ownerDocument.createEvent('Event');
        legacyEvent.initEvent(eventName, true, false);
        elem.dispatchEvent(legacyEvent);
    };

    field.focus();

    // Use a delay to allow focus events to trigger and to give some
    // breathing room to frameworks that rely on promises to update their
    // state, like React. Not doing so can break OTP input, see issue #2215.
    await Promise.resolve();

    field.dispatchEvent(new FocusEvent('focus', { bubbles: false, cancelable: false }));
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true, cancelable: false }));

    // https://w3c.github.io/uievents/#keypress-event-order
    field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: false, key: value }));
    field.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: false, inputType: 'insertText', data: value }));
    field.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: false, key: value }));
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true, cancelable: false }));
    field.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: false, key: value }));
    field.dispatchEvent(new Event('change', { bubbles: true, cancelable: false }));

    // Some pages will not accept the value change without dispatching events directly to the document
    dispatchLegacyEvent(field, 'input');
    dispatchLegacyEvent(field, 'change');
};


// Update the password field if form has been updated with a new identical element (Moodle).
// If found, replace the new input field to the combination.
const checkIdenticalPasswordFields = function(combination) {
    if (combination?.form && combination?.password && !combination.form.contains(combination.password)) {
        const newPasswordField = getPasswordFieldFromForm(combination);
        if (newPasswordField && areNamedNodeMapsEqual(combination.password.attributes, newPasswordField.attributes)) {
            combination.password = newPasswordField;
        }
    }
};

// Sometimes username field is changed to readOnly. Look for a password field instead inside the form.
const checkReadOnlyUsernameField = function(combination) {
    if (combination?.username && combination?.username?.readOnly && combination?.form && !combination?.password) {
        const passwordField = getPasswordFieldFromForm(combination);
        if (kpxcFields.isVisible(passwordField)) {
            combination.password = passwordField;
        }
    }
};

// Checks if two NamedNodeMaps (attribute lists) are equal
const areNamedNodeMapsEqual = function(currentNodeMap, newNodeMap) {
    if (!currentNodeMap || !newNodeMap) {
        return false;
    }

    const fieldAttributes = Array.from(currentNodeMap);
    const newFieldAttributes = Array.from(newNodeMap);

    if (fieldAttributes.length !== newFieldAttributes.length) {
        return false;
    }

    for (const attr of fieldAttributes) {
        const newAttr = newFieldAttributes.find((newAttr) => newAttr?.name === attr?.name);
        if (!newAttr || newAttr?.value !== attr?.value) {
            return false;
        }
    }

    return true;
};

const getPasswordFieldFromForm = function(combination) {
    if (!combination) {
        return undefined;
    }

    const formInputs = kpxcObserverHelper.getInputs(combination.form);
    return formInputs?.find(
        formInput => formInput?.getLowerCaseAttribute('type') === 'password' && !formInput?.readOnly
    );
};
