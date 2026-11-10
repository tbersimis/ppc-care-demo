// Live Hub Click-to-Call for the PPC (ΔΕΗ) customer care demo.
(function () {
    var USERNAME = 'ppcusername';            // "caller" in basic.js
    var PASSWORD = 'ppcpassword';            // "password" in basic.js (must not be empty)
    var CALL_NUMBER = 'C2C-PPC-Call';             // shown as the callee in Live Hub (no spaces)
    var DOMAIN = 'fmkuubmkvfza.sip1-region1.audiocodes.io';                // "domain" in basic.js
    var WSS = 'wss://fmkuubmkvfza.sip1-region1.audiocodes.io';             // first entry of "addresses" in basic.js

    var slot = document.getElementById('c2c-slot') || document.body;
    var note = document.getElementById('c2c-note');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !navigator.mediaDevices.enumerateDevices) {
        console.error('WebRTC not supported.');
        if (note) note.textContent = 'Ο browser δεν υποστηρίζει κλήσεις. Δοκιμάστε Chrome, Edge ή Safari.';
        return;
    }

    if (!window.customElements || !customElements.get('click-to-call-widget')) {
        if (!document.getElementById('clickToCallWidget')) {
            var s = document.createElement('script');
            s.src = '/c2c/click-to-call-widget.js';
            s.id = 'clickToCallWidget';
            s.defer = true;
            document.head.appendChild(s);
        }
    }

    var config = {
        c2c_config: {
            caller: USERNAME, password: PASSWORD, callerPhone: '', call: CALL_NUMBER,
            dtmfKeypadEnabled: true, screenSharingEnabled: false, keepConnectionAfterCall: 0
        },
        c2c_serverConfig: { domain: DOMAIN, addresses: [WSS] }
    };

    var widget = document.createElement('click-to-call-widget');
    widget.setAttribute('config', JSON.stringify(config));
    widget.setAttribute('form', JSON.stringify({ isValid: true }));
    if (note) note.remove();
    slot.appendChild(widget);
})();
