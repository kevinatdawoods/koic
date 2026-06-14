let term_obj, socket_obj;
let ws_ping_timer = null;
let pane_active = false;
let is_editing = false;
let draft_edit_mode = false;
let at_command_prompt = false;
let editor_already_shown = false;
let post_menu = false;
let last_more_seen = 0;
let local_echo = false;
let password_echo = false;
let forcedInput = null; // 'NAME' | 'PASSWORD' | null

// For some prompts (user/forum names), the BBS expects Title Case. Apply a lightweight
// transform to local echo + what we send so the UI matches BBS expectations.
let koic_titlecase_active = false;

function koicShouldTitlecasePrompt(promptText) {
    const p = String(promptText || '');
    if (!p) return false;
    if (/\bPassword:\s*$/i.test(p)) return false;
    if (/\bforum\b.*(?:name|number|#)?\b.*(?:\?\s*->|->|:\s*$|\?\s*$)/i.test(p)) return true;
    return /\b(Name:|User:)\b/i.test(p);
}

function koicTitlecaseWords(str) {
    const s = String(str || '');
    let out = '';
    let atWordStart = true;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (/\s/.test(ch)) {
            out += ch;
            atWordStart = true;
            continue;
        }
        if (atWordStart && ch >= 'a' && ch <= 'z') out += ch.toUpperCase();
        else out += ch;
        atWordStart = false;
    }
    return out;
}

function koicTitlecaseApplyForAppend(prev, added) {
    const p = String(prev || '');
    const a = String(added || '');
    let atWordStart = (p.length === 0) || /\s$/.test(p);
    let out = '';
    for (let i = 0; i < a.length; i++) {
        const ch = a[i];
        if (/\s/.test(ch)) {
            out += ch;
            atWordStart = true;
            continue;
        }
        if (atWordStart && ch >= 'a' && ch <= 'z') out += ch.toUpperCase();
        else out += ch;
        atWordStart = false;
    }
    return out;
}

// DOC G_FIVE (0xA4): local five-line entry mode (Xpress/profile/e-list hooks).
let awaiting_five = false;
let five_which = 0;
let five_prev_pane_active = false;

// Debug: last prompt tail seen by checkGate() (helps tune local-echo heuristics).
let last_tail_prompt = '';
let last_cmd_candidate = '';

// When the reading pane is overlaying the terminal, local echo written to xterm
// isn't visible. Mirror typed value into the pane's cmd-line.
// IMPORTANT: the phantom-input may still contain earlier keystrokes (e.g. the 'j'
// that initiated Jump). Track the phantom-input value at the moment the prompt
// appears, and only display the suffix typed after that.
let pane_inline_echo_base = '';
let pane_inline_echo_origin_raw = '';
let pane_inline_echo_raw = '';
let pane_inline_echo_value = '';
let lobby_pane_bootstrapped = false;
let lobby_cty_sent = false;

// Last cmd-line text announced to screen readers from the reading pane.
let _ariaLastPaneCmd = '';
// Last prompt text announced to screen readers — used to suppress redundant announcements.
let _ariaLastPrompt = '';

// Back/leave guard: mobile Back can accidentally close the page.
let nav_guard_active = false;
let nav_guard_installed = false;
let nav_guard_confirming = false;

// Guard against reconnect/double-tap reinitializing xterm and stacking listeners.
let koic_terminal_initialized = false;

// ── Screen-reader live regions ────────────────────────────────────────────────
// ariaAnnounce(raw)           → polite region (reading pane content)
// ariaAnnounce(raw, true)     → assertive region (prompts, state changes)
//
// Strips ANSI/VT escape sequences and control characters, then pushes the
// resulting plain text into the appropriate aria-live region so VoiceOver /
// NVDA users can follow output without needing to interact with the xterm canvas.

let _ariaDebounceTimer = null;
let _ariaPending = '';
let _ariaAssertiveTimer = null;

function ariaAnnounce(raw, assertive) {
    if (!raw) return;
    // Strip all ANSI / VT100 escape sequences (CSI, OSC, etc.)
    let plain = raw
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b[^[\]]/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .replace(/\r\n/g, ' ')
        .replace(/[\r\n]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    if (!plain) return;

    if (assertive) {
        // Assertive: announce immediately, no debounce.
        clearTimeout(_ariaAssertiveTimer);
        _ariaAssertiveTimer = setTimeout(() => {
            const el = document.getElementById('aria-live-region-assertive');
            if (!el) return;
            el.textContent = '';
            requestAnimationFrame(() => { el.textContent = plain; });
        }, 0);
    } else {
        // Polite: debounce rapid writes into a single announcement (~80 ms window).
        _ariaPending += ' ' + plain;
        clearTimeout(_ariaDebounceTimer);
        _ariaDebounceTimer = setTimeout(() => {
            const el = document.getElementById('aria-live-region');
            if (!el) return;
            el.textContent = _ariaPending.trim();
            _ariaPending = '';
        }, 80);
    }
}

// Reading pane enhancement: linkify URLs so they are tappable.
let _koic_pane_linkify_timer = 0;
let _koic_pane_linkify_seq = 0;

function koicNormalizeUrl(raw) {
    const t = String(raw || '').trim();
    if (!t) return '';
    if (/^https?:\/\//i.test(t)) return t;
    if (/^www\./i.test(t)) return 'https://' + t;
    return '';
}

function koicSplitTrailingPunct(url) {
    // Avoid including common trailing punctuation in the clickable URL.
    // Example: "https://a/b)." => url="https://a/b" tail=")."
    let u = String(url || '');
    let tail = '';
    while (u.length) {
        const ch = u[u.length - 1];
        if (/[\]\)\.,;:!?]/.test(ch)) {
            tail = ch + tail;
            u = u.slice(0, -1);
            continue;
        }
        break;
    }
    return { url: u, tail };
}

function koicLinkifyTextNode(textNode) {
    const text = String(textNode?.nodeValue || '');
    if (!text) return false;

    // Fast-path: no URL-ish substring.
    if (!/https?:\/\/|www\./i.test(text)) return false;

    // Match URLs without whitespace/quotes/angle brackets.
    const re = /(https?:\/\/[^\s<>'"]+|\bwww\.[^\s<>'"]+)/ig;
    let m;
    let last = 0;
    const frag = document.createDocumentFragment();
    let changed = false;

    while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const raw = m[0] || '';
        if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));

        const split = koicSplitTrailingPunct(raw);
        const href = koicNormalizeUrl(split.url);
        if (!href) {
            frag.appendChild(document.createTextNode(raw));
        } else {
            const a = document.createElement('a');
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = split.url;
            frag.appendChild(a);
            if (split.tail) frag.appendChild(document.createTextNode(split.tail));
            changed = true;
        }
        last = start + raw.length;
    }

    if (!changed) return false;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));

    try {
        textNode.parentNode.replaceChild(frag, textNode);
        return true;
    } catch (e) {
        return false;
    }
}

function koicLinkifyPane(pane) {
    try {
        if (!pane) return;
        const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                try {
                    if (!node || !node.parentElement) return NodeFilter.FILTER_REJECT;
                    // Don't touch existing links.
                    if (node.parentElement.closest && node.parentElement.closest('a')) return NodeFilter.FILTER_REJECT;
                    // Don't linkify inside the editor overlay.
                    if (node.parentElement.closest && node.parentElement.closest('#editor-overlay')) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                } catch (e) {
                    return NodeFilter.FILTER_REJECT;
                }
            }
        });

        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const n of nodes) koicLinkifyTextNode(n);
    } catch (e) {}
}

function schedulePaneLinkify() {
    try {
        const pane = document.getElementById('reading-pane');
        if (!pane || pane.style.display === 'none') return;
        _koic_pane_linkify_seq++;
        if (_koic_pane_linkify_timer) return;
        _koic_pane_linkify_timer = setTimeout(() => {
            _koic_pane_linkify_timer = 0;
            try { koicLinkifyPane(pane); } catch (e) {}
        }, 0);
    } catch (e) {}
}

function navGuardInstallOnce() {
    if (nav_guard_installed) return;
    nav_guard_installed = true;

    window.addEventListener('popstate', () => {
        if (!nav_guard_active) return;
        if (nav_guard_confirming) return;
        nav_guard_confirming = true;

        const ok = window.confirm('Are you sure you wish to leave this window?');
        if (ok) {
            nav_guard_active = false;
            // We used pushState to trap Back in-page. One more back actually leaves.
            setTimeout(() => {
                try { history.back(); } catch (e) {}
            }, 0);
        } else {
            // Re-arm the trap so the next Back still prompts.
            try { history.pushState({ koic_nav_guard: 1 }, '', location.href); } catch (e) {}
        }

        setTimeout(() => { nav_guard_confirming = false; }, 0);
    });

    window.addEventListener('beforeunload', (e) => {
        if (!nav_guard_active) return;
        // Most browsers ignore custom text; returning a value triggers the native prompt.
        e.preventDefault();
        e.returnValue = '';
        return '';
    });
}

function navGuardEnable() {
    navGuardInstallOnce();
    if (nav_guard_active) return;
    nav_guard_active = true;
    // Add a dummy history entry so Back stays in-page (and we can confirm).
    try { history.pushState({ koic_nav_guard: 1 }, '', location.href); } catch (e) {}
}

const KOIC_VERSION = (window.KOIC_VERSION || '');
const KOIC_DEBUG_KEY = 'koic_debug_hud';

function setDebugHudEnabled(on) {
    try { localStorage.setItem(KOIC_DEBUG_KEY, on ? '1' : '0'); } catch (e) {}
    updateDebugHud();
}

function initDebugHudFromUrl() {
    try {
        const q = new URLSearchParams(window.location.search || '');
        const want = (q.get('hud') || '').toLowerCase();
        const hash = (window.location.hash || '').toLowerCase();
        if (want === '1' || want === 'true' || want === 'yes' || hash.includes('hud')) {
            setDebugHudEnabled(true);
        }
    } catch (e) {}
}

const KOIC_CFG_KEY = 'koic_client_cfg_v1';
const KOIC_CFG_DEFAULT = {
    ansi: true,
    autoLogin: false,
    loginUser: '',
    loginPass: '',
    useReadingPane: true,
    showNextBar: true,
    selectionMode: true,
    fontSize: 15,
    enemies: '',
};
let clientCfg = { ...KOIC_CFG_DEFAULT };

// Session-scoped guard to avoid auto-submitting password in the wrong context.
let autoLoginArmed = false;

// KOIC control tokens may be delivered in the same WS frame as BBS output,
// and can even be split across frames. Keep a small byte carry to prevent
// rendering partial tokens into the terminal.
let koicCtrlCarryBytes = new Uint8Array(0);

function koicAsciiBytes(str) {
    const s = String(str || '');
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
}

const KOIC_TOK_AUTOLOGIN = koicAsciiBytes('__AUTOLOGIN_ECHO_NAME__:');
const KOIC_TOK_PASSWORD  = koicAsciiBytes('__PASSWORD_MODE__');
const KOIC_TOK_AWAIT_STR = koicAsciiBytes('__AWAITING_STR__'); // G_STR non-password field
const KOIC_TOK_AWAIT_NAME = koicAsciiBytes('__AWAITING_NAME__');
const KOIC_TOK_MORE = koicAsciiBytes('__MORE_PROMPT__');

function koicMatchAt(bytes, pos, tokBytes) {
    if (pos + tokBytes.length > bytes.length) return false;
    for (let i = 0; i < tokBytes.length; i++) {
        if (bytes[pos + i] !== tokBytes[i]) return false;
    }
    return true;
}

function koicAppendAscii(outArr, s) {
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) outArr.push(str.charCodeAt(i) & 0xff);
}

function koicEnterAwaitingName() {
    forcedInput = 'NAME';
    local_echo = true;
    password_echo = false;
    koic_titlecase_active = true;
    const bridge = document.getElementById('phantom-input');
    if (bridge) bridge.type = 'text';
    focusTerminal();
    ariaAnnounce('Name:', true);
}

function koicEnterAwaitingStr() {
    // G_STR for a non-password field (config info, etc.): plain local echo, no masking.
    forcedInput = 'STR';
    local_echo = true;
    password_echo = false;
    koic_titlecase_active = false;
    const bridge = document.getElementById('phantom-input');
    if (bridge) bridge.type = 'text';
    focusTerminal();
}

function koicEnterPasswordModeAndMaybeAutofill(outArr) {
    forcedInput = 'PASSWORD';
    local_echo = false;
    password_echo = true;
    koic_titlecase_active = false;
    const bridge = document.getElementById('phantom-input');
    if (bridge) bridge.type = 'password';
    focusTerminal();
    ariaAnnounce('Password:', true);

    if (autoLoginArmed && clientCfg.autoLogin && clientCfg.loginPass) {
        const dots = '.'.repeat(String(clientCfg.loginPass || '').length);
        if (dots) koicAppendAscii(outArr, dots);
        koicAppendAscii(outArr, "\r\n");
        try {
            socket_obj.send(clientCfg.loginPass);
            socket_obj.send("\r\n");
        } catch (e) {}
        autoLoginArmed = false;
        forcedInput = null;
    }
}

function koicFilterAndHandleControlBytes(bytes) {
    // Prepend carry (partial token fragments from prior WS frame).
    let merged = bytes;
    if (koicCtrlCarryBytes && koicCtrlCarryBytes.length) {
        const tmp = new Uint8Array(koicCtrlCarryBytes.length + bytes.length);
        tmp.set(koicCtrlCarryBytes, 0);
        tmp.set(bytes, koicCtrlCarryBytes.length);
        merged = tmp;
        koicCtrlCarryBytes = new Uint8Array(0);
    }

    const out = [];
    let i = 0;

    const toks = [KOIC_TOK_AUTOLOGIN, KOIC_TOK_PASSWORD, KOIC_TOK_AWAIT_NAME, KOIC_TOK_MORE];

    while (i < merged.length) {
        // __AUTOLOGIN_ECHO_NAME__:<b64>\n
        if (koicMatchAt(merged, i, KOIC_TOK_AUTOLOGIN)) {
            const payloadStart = i + KOIC_TOK_AUTOLOGIN.length;
            let j = payloadStart;
            while (j < merged.length && merged[j] !== 10 && merged[j] !== 13) j++;
            if (j >= merged.length) {
                // No terminator yet; carry from token start.
                koicCtrlCarryBytes = merged.slice(i);
                break;
            }
            // Decode base64 payload (ASCII)
            let b64 = '';
            try {
                const slice = merged.slice(payloadStart, j);
                b64 = String.fromCharCode(...slice);
            } catch (e) { b64 = ''; }
            let name = '';
            try { name = b64 ? atob(b64) : ''; } catch (e) { name = ''; }
            if (name) koicAppendAscii(out, name);

            // Skip optional newline
            if (j < merged.length && (merged[j] === 10 || merged[j] === 13)) j++;

            // Ensure the next prompt starts on its own line (avoid "Name: userPassword:").
            // If the next output already begins with a newline, don't add another.
            if (name) {
                const nextByte = (j < merged.length) ? merged[j] : -1;
                if (nextByte !== 10 && nextByte !== 13) {
                    koicAppendAscii(out, "\r\n");
                }
            }
            i = j;
            continue;
        }

        // Exact tokens (no payload)
        if (koicMatchAt(merged, i, KOIC_TOK_PASSWORD)) {
            koicEnterPasswordModeAndMaybeAutofill(out);
            i += KOIC_TOK_PASSWORD.length;
            continue;
        }
        if (koicMatchAt(merged, i, KOIC_TOK_AWAIT_STR)) {
            koicEnterAwaitingStr();
            i += KOIC_TOK_AWAIT_STR.length;
            continue;
        }
        if (koicMatchAt(merged, i, KOIC_TOK_AWAIT_NAME)) {
            koicEnterAwaitingName();
            i += KOIC_TOK_AWAIT_NAME.length;
            continue;
        }
        if (koicMatchAt(merged, i, KOIC_TOK_MORE)) {
            last_more_seen = Date.now();
            setNextBarVisible(!!(pane_active && clientCfg.showNextBar));
            ariaAnnounce('More — press space to continue.', true);
            i += KOIC_TOK_MORE.length;
            continue;
        }

        // Partial match check to prevent leakage
        let isPartial = false;
        for (const t of toks) {
            if (koicIsPartialMatch(merged, i, t)) {
                isPartial = true;
                break;
            }
        }
        if (isPartial) {
            koicCtrlCarryBytes = merged.slice(i);
            break;
        }

        out.push(merged[i]);
        i++;
    }

    return new Uint8Array(out);
}

function koicIsPartialMatch(bytes, pos, tok) {
    const remaining = bytes.length - pos;
    if (remaining >= tok.length) return false;
    for (let j = 0; j < remaining; j++) {
        if (bytes[pos + j] !== tok[j]) return false;
    }
    return true;
}

// Guard against resize recursion while we auto-fit font size.
let _koic_autofit_busy = false;

// Guard against resize recursion while we auto-fit frame width.
let _koic_frame_autofit_busy = false;

// Desired NEXT/SPACE bar visibility (actual visibility may be suppressed while keyboard is up).
let nextbar_wanted = false;

// Android Brave sometimes fails to report the keyboard inset on subsequent focuses.
// Cache the last known bottom inset so we can keep the reading pane above the keyboard.
let last_keyboard_inset = 0;

// VirtualKeyboard API (Chromium Android): provides keyboard geometry even when the viewport
// doesn't resize on focus.
let vk_inset = 0;

function setupVirtualKeyboardHooks() {
    try {
        const vk = navigator.virtualKeyboard;
        if (!vk || typeof vk.addEventListener !== 'function') return;

        // Prefer overlay mode and handle layout ourselves.
        try { vk.overlaysContent = true; } catch (e) {}

        vk.addEventListener('geometrychange', () => {
            try {
                const r = vk.boundingRect;
                const h = (r && typeof r.height === 'number') ? Math.max(0, r.height) : 0;
                vk_inset = h;
                if (h > 0) last_keyboard_inset = Math.max(last_keyboard_inset, h);
            } catch (e) {}
            try { scheduleKeyboardResize(); } catch (e) {}
        });
    } catch (e) {}
}

function isKeyboardFocusActive() {
    try {
        const ae = document.activeElement;
        if (!ae) return false;
        if (ae === document.getElementById('phantom-input')) return true;
        // xterm may use a hidden textarea for input on some browsers.
        if (ae && ae.tagName === 'TEXTAREA' && ae.closest && ae.closest('#terminal')) return true;
    } catch (e) {}
    return false;
}

function getVisualViewportBottomInset() {
    const vv = window.visualViewport;
    if (!vv || !vv.height) return 0;
    return Math.max(0, window.innerHeight - (vv.height + (vv.offsetTop || 0)));
}

function isSoftKeyboardVisible() {
    if (vk_inset > 80) return true;
    const inset = getVisualViewportBottomInset();
    if (inset > 80) return true;
    // Fallback: if we're focused into an input on touch devices, assume the keyboard is up.
    // Use a cached inset if we have one.
    return isTouchLike() && isKeyboardFocusActive() && last_keyboard_inset > 0;
}

function applyNextBarVisibility(skipResize) {
    const nb = document.getElementById('mobile-nav-bar');
    if (!nb) return;
    const shouldShow = (!!nextbar_wanted) && !is_editing && !isSoftKeyboardVisible();
    const next = shouldShow ? 'flex' : 'none';
    if (nb.style.display !== next) {
        nb.style.display = next;
        if (!skipResize) {
            try { handleResize(); } catch (e) {}
        }
    }
}

function loadClientConfig() {
    try {
        const raw = localStorage.getItem(KOIC_CFG_KEY);
        if (!raw) return { ...KOIC_CFG_DEFAULT };
        const parsed = JSON.parse(raw);
        const merged = { ...KOIC_CFG_DEFAULT, ...(parsed || {}) };
        if (typeof merged.selectionMode !== 'boolean') merged.selectionMode = true;
        if (typeof merged.enemies !== 'string') merged.enemies = '';
        return merged;
    } catch (e) {
        return { ...KOIC_CFG_DEFAULT };
    }
}

function saveClientConfig() {
    try { localStorage.setItem(KOIC_CFG_KEY, JSON.stringify(clientCfg)); } catch (e) {}
}

function setNextBarVisible(show) {
    try {
        nextbar_wanted = !!show;
        applyNextBarVisibility(false);
    } catch (e) {}
}

function applyClientConfig() {
    const fs = Number(clientCfg.fontSize) || KOIC_CFG_DEFAULT.fontSize;
    try {
        const pane = document.getElementById('reading-pane');
        if (pane) pane.style.fontSize = fs + 'px';
    } catch (e) {}
    try {
        if (term_obj) term_obj.setOption('fontSize', fs);
    } catch (e) {}

    // Tell server our ANSI preference (used for DOC CONFIG handshake).
    try {
        if (socket_obj?.readyState === 1) {
            socket_obj.send('__SET_ANSI__:' + (clientCfg.ansi ? '1' : '0'));
        }
    } catch (e) {}

    // Provide username to server for one-shot autofill on DOC G_NAME.
    try {
        if (socket_obj?.readyState === 1) {
            socket_obj.send('__LOGIN__:' + (clientCfg.loginUser || ''));
        }
    } catch (e) {}

    // Provide enemy list to server for local blocking of posts/xpress.
    try {
        if (socket_obj?.readyState === 1) {
            socket_obj.send('__ENEMIES__:' + (clientCfg.enemies || ''));
        }
    } catch (e) {}

    // If reading pane is disabled, hide it immediately.
    if (!clientCfg.useReadingPane) {
        pane_active = false;
        const pane = document.getElementById('reading-pane');
        if (pane) pane.style.display = 'none';
    }

    // Selection mode: allow highlight/copy from reading pane without it stealing focus.
    try {
        const pane = document.getElementById('reading-pane');
        if (pane) {
            const mode = !!clientCfg.selectionMode;
            pane.style.userSelect = mode ? 'text' : 'none';
            pane.style.webkitUserSelect = mode ? 'text' : 'none';
        }
    } catch (e) {}

    // NEXT/SPACE bar visibility is managed by gate + MORE prompt, but respect the setting.
    try {
        setNextBarVisible(!!(pane_active && clientCfg.showNextBar));
    } catch (e) {}

    try { handleResize(); } catch (e) {}
}

function openClientConfig() {
    const ov = document.getElementById('cfg-overlay');
    if (!ov) return;
    clientCfg = loadClientConfig();
    const ansi = document.getElementById('cfg-ansi');
    const al = document.getElementById('cfg-autologin');
    const user = document.getElementById('cfg-user');
    const pass = document.getElementById('cfg-pass');
    const usePane = document.getElementById('cfg-use-pane');
    const showNext = document.getElementById('cfg-show-next');
    const selMode = document.getElementById('cfg-select');
    const font = document.getElementById('cfg-font');
    const enemies = document.getElementById('cfg-enemies');
    if (ansi) ansi.checked = !!clientCfg.ansi;
    if (al) al.checked = !!clientCfg.autoLogin;
    if (user) user.value = (clientCfg.loginUser || '');
    if (pass) pass.value = (clientCfg.loginPass || '');
    if (usePane) usePane.checked = !!clientCfg.useReadingPane;
    if (showNext) showNext.checked = !!clientCfg.showNextBar;
    if (selMode) selMode.checked = !!clientCfg.selectionMode;
    if (font) font.value = String(Number(clientCfg.fontSize) || KOIC_CFG_DEFAULT.fontSize);
    if (enemies) enemies.value = (clientCfg.enemies || '');
    ov.style.display = 'block';
    ov.style.pointerEvents = 'auto';
    // Avoid fighting with the soft keyboard while in modal.
    if (isTouchLike()) hideKeyboard();
}

function closeClientConfig() {
    const ov = document.getElementById('cfg-overlay');
    if (ov) {
        ov.style.display = 'none';
        ov.style.pointerEvents = 'none';
    }

    // Restore control immediately (mobile browsers often block async focus).
    try { focusTerminal(); } catch (e) {}

    // Tweak: Inject Enter key to refresh the BBS prompt 
    // and exit any 'pending' state caused by the UI interruption
    if (socket_obj && socket_obj.readyState === WebSocket.OPEN) {
        socket_obj.send("\r");
    }
}

function cfgOverlayClick(e) {
    // Click outside the panel closes.
    const panel = document.getElementById('cfg-panel');
    if (!panel) return;
    if (e && e.target === document.getElementById('cfg-overlay')) closeClientConfig();
}

function applyClientConfigFromUI(closeAfter) {
    const ansi = document.getElementById('cfg-ansi');
    const al = document.getElementById('cfg-autologin');
    const user = document.getElementById('cfg-user');
    const pass = document.getElementById('cfg-pass');
    const usePane = document.getElementById('cfg-use-pane');
    const showNext = document.getElementById('cfg-show-next');
    const selMode = document.getElementById('cfg-select');
    const font = document.getElementById('cfg-font');
    const enemies = document.getElementById('cfg-enemies');
    clientCfg.ansi = !!ansi?.checked;
    clientCfg.autoLogin = !!al?.checked;
    clientCfg.loginUser = (user?.value || '').trim();
    clientCfg.loginPass = (pass?.value || '');
    clientCfg.useReadingPane = !!usePane?.checked;
    clientCfg.showNextBar = !!showNext?.checked;
    clientCfg.selectionMode = !!selMode?.checked;
    clientCfg.fontSize = Number(font?.value) || KOIC_CFG_DEFAULT.fontSize;
    clientCfg.enemies = (enemies?.value || '');
    saveClientConfig();
    applyClientConfig();
    if (closeAfter) closeClientConfig();
}

function resetClientConfig() {
    clientCfg = { ...KOIC_CFG_DEFAULT };
    saveClientConfig();
    applyClientConfig();
    openClientConfig();
}

function scrollAllToBottom(forcePane = false) {
    try { term_obj?.scrollToBottom(); } catch (e) {}
    try {
        const pane = document.getElementById('reading-pane');
        if (pane && pane_active) {
            if (forcePane) {
                pane.scrollTop = pane.scrollHeight;
            } else {
                const atBottom = (pane.scrollHeight - pane.scrollTop - pane.clientHeight) < 24;
                if (atBottom) pane.scrollTop = pane.scrollHeight;
            }
        }
    } catch (e) {}
}

function joinPromptAndValue(base, value) {
    const b = String(base || '');
    const v = String(value || '').trimEnd();
    if (!b) return v;
    if (!v) return b;

    // Keep the cursor feel: do not inject a space after common prompt terminators.
    // Examples:
    //  - "... ->" + "j" => "... ->j"
    //  - "Name:" + "bob" => "Name:bob"
    // If the prompt already ends with whitespace, just append.
    if (/\s$/.test(b)) return b + v;
    if (/(?:->|:)$/i.test(b)) return b + v;
    return b + ' ' + v;
}

function computePaneInlineEchoDisplay(raw) {
    const r = String(raw || '');
    const origin = String(pane_inline_echo_origin_raw || '');
    if (!origin) return r;
    if (r.startsWith(origin)) return r.slice(origin.length);
    return r;
}

function renderPaneInlineEcho() {
    if (!pane_active) return;
    try {
        const el = document.querySelector('#reading-pane .cmd-line');
        if (!el) return;
        if (!pane_inline_echo_base) return;

        let base = String(pane_inline_echo_base || '');
        let value = String(pane_inline_echo_value || '');

        // Title Case mode: mirror what we will send for Name/User/forum-name prompts.
        if (koic_titlecase_active && koicShouldTitlecasePrompt(base) && value) {
            value = koicTitlecaseWords(value);
        }

        // Read-cmd prompt UX: show a space after the arrow, and expand single-letter commands.
        // Classic BBS clients often render like: "Read cmd -> sStop".
        if (/^Read cmd\s*->\s*$/i.test(base)) {
            base = base.replace(/->\s*$/i, '-> ');
            if (value && value.length === 1) {
                const ch = value.toLowerCase();
                const map = {
                    s: 'Stop',
                    n: 'Next',
                    p: 'Prev',
                    r: 'Reply',
                    c: 'Continue',
                };
                if (map[ch]) value = value + map[ch];
            }
        }

        const full = joinPromptAndValue(base, value);
        el.textContent = wrapToCols(full);
    } catch (e) {}
}

function setPaneInlineEchoValue(v) {
    pane_inline_echo_value = (v || '');
    renderPaneInlineEcho();
}

function setPaneInlineEchoRawValue(raw) {
    pane_inline_echo_raw = String(raw || '');
    setPaneInlineEchoValue(computePaneInlineEchoDisplay(pane_inline_echo_raw));
}

function startPaneInlineEchoForPrompt(base, bridgeValue) {
    pane_inline_echo_base = String(base || '');
    pane_inline_echo_origin_raw = String(bridgeValue || '');
    setPaneInlineEchoRawValue(String(bridgeValue || ''));
}

function scheduleKeyboardResize() {
    // Mobile keyboards animate; do an immediate resize and a couple follow-ups.
    try { handleResize(); } catch (e) {}
    // Do not force-scroll the reading pane here; it breaks scrolling back.
    setTimeout(() => { try { handleResize(); } catch (e) {} }, 60);
    setTimeout(() => { try { handleResize(); } catch (e) {} }, 220);
    // Android Chrome/Brave sometimes report viewport changes late.
    setTimeout(() => { try { handleResize(); } catch (e) {} }, 520);
    setTimeout(() => { try { handleResize(); } catch (e) {} }, 900);
}

function startSession() {
    document.getElementById('start-overlay').style.display = 'none';
    navGuardEnable();
    clientCfg = loadClientConfig();
    setupTerminal();
    applyClientConfig();
    initDebugHudFromUrl();
    connect();
}

function isTouchLike() {
    return (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function setupTerminal() {
    // Reconnect path: keep the existing terminal instance and handlers.
    if (koic_terminal_initialized && term_obj) {
        try { if (!isTouchLike()) focusTerminal(); } catch (e) {}
        return;
    }

    term_obj = new Terminal({
        cursorBlink: true,
        fontSize: (Number(clientCfg?.fontSize) || 15),
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        rendererType: 'canvas',
        theme: { background: '#000', foreground: '#33FF33' },
        convertEol: true,
    });
    term_obj.open(document.getElementById('terminal'));

    // Fonts can load after xterm measures cell width (especially on mobile).
    // Re-measure after fonts settle to reduce 1px/last-column clipping.
    scheduleFontRemeasure();
    updateDebugHud();

    // Force a 40-column grid so the BBS doesn't wrap awkwardly.
    // (We aren't using xterm FitAddon, so cols won't auto-fit.)
    setTimeout(() => {
        try { handleResize(); } catch (e) {}
    }, 0);

    const bridge = document.getElementById('phantom-input');
    let bridge_last = "";

    term_obj.onData(data => {
        if (socket_obj?.readyState === 1 && !is_editing) {
            // If the phantom input is focused, let its diffing path own input to avoid double-send.
            try {
                if (bridge && document.activeElement === bridge) return;
            } catch (e) {}

            // DOC client-mode does not reliably echo at some prompts (notably Name/User).
            // Provide local echo only when we detect Name/User input.
            // If Title Case is active, apply it to both echo and what we send.
            if (koic_titlecase_active && !password_echo && data && data.length === 1 && data !== "\r" && data !== "\n" && data !== "\b" && data !== "\u007f") {
                if (data >= 'a' && data <= 'z') {
                    // Word start heuristic: look at the phantom-input value when available.
                    try {
                        const cur = bridge ? (bridge.value || '') : '';
                        const last = cur.length ? cur[cur.length - 1] : '';
                        if (!last || /\s/.test(last)) data = data.toUpperCase();
                    } catch (e) {}
                }
            }

            if (local_echo || password_echo) {
                if (data === "\u007f" || data === "\b") {
                    term_obj.write("\b \b");
                } else if (data === "\r" || data === "\n") {
                    term_obj.write("\r\n");
                } else {
                    term_obj.write(password_echo ? "." : data);
                }
            }

            // Send transformed value when title-case mode is active.
            socket_obj.send(data);
            if (data === "\r" || data === "\n") {
                forcedInput = null;
                koic_titlecase_active = false;
                // Keep the phantom-input buffer in sync. If Enter came from xterm,
                // the phantom input might still hold previous prompt text (e.g. a prior Jump target),
                // causing the next prompt to append and send extra characters.
                try {
                    if (bridge) bridge.value = "";
                    bridge_last = "";
                } catch (e) {}
                try {
                    setPaneInlineEchoValue('');
                    pane_inline_echo_base = '';
                    pane_inline_echo_origin_raw = '';
                    pane_inline_echo_raw = '';
                } catch (e) {}
            }
        }
    });

    setupVirtualKeyboardHooks();

    // Desktop shortcut: Ctrl+, opens config (common "preferences" pattern).
    document.addEventListener('keydown', (e) => {
        try {
            if (e && e.ctrlKey && (e.key === ',' || e.key === 'Comma')) {
                e.preventDefault();
                openClientConfig();
            }
            // Debug HUD toggles (Firefox responsive mode can eat some Ctrl+Alt combos).
            if (e && (e.key === 'F9' || e.keyCode === 120)) {
                e.preventDefault();
                toggleDebugHud();
            }
            if (e && e.ctrlKey && e.altKey && (e.key === 'd' || e.key === 'D')) {
                e.preventDefault();
                toggleDebugHud();
            }
            if (e && e.ctrlKey && e.shiftKey && (e.key === 'd' || e.key === 'D')) {
                e.preventDefault();
                toggleDebugHud();
            }
            if (e && e.key === 'Escape') {
                const ov = document.getElementById('cfg-overlay');
                if (ov && ov.style.display === 'block') {
                    e.preventDefault();
                    closeClientConfig();
                }
            }
        } catch (err) {}
    }, true);

    // Console helpers (works even if keybindings are swallowed).
    try {
        window.koicToggleHud = () => toggleDebugHud();
        window.koicHudOn = () => setDebugHudEnabled(true);
        window.koicHudOff = () => setDebugHudEnabled(false);
    } catch (e) {}

    function bridgeSendEnter() {
        if (!socket_obj || socket_obj.readyState !== 1) return;
        if (local_echo || password_echo) term_obj.write("\r\n");
        // Telnet line termination: be generous.
        socket_obj.send("\r\n");
        forcedInput = null;
        koic_titlecase_active = false;
        bridge.value = "";
        bridge_last = "";
        setPaneInlineEchoValue('');
        pane_inline_echo_base = '';
        pane_inline_echo_origin_raw = '';
        pane_inline_echo_raw = '';
    }

    // On touch devices, focus must be triggered by a user gesture.
    // Use pointer/touch events to reliably bring up the keyboard.
    const termEl = document.getElementById('terminal');
    const paneEl = document.getElementById('reading-pane');
    if (termEl) {
        termEl.addEventListener('pointerdown', () => focusTerminal(), { passive: true });
        termEl.addEventListener('touchstart', () => focusTerminal(), { passive: true });
    }
    if (paneEl) {
        paneEl.addEventListener('pointerdown', (e) => panePointerDown(e), { passive: true });
        paneEl.addEventListener('touchstart', (e) => panePointerDown(e), { passive: true });
    }
    
    // Phantom-input is used as a fallback typing bridge on some mobile browsers.
    // IMPORTANT: don't rely on `e.data` (often null on Android IME). Instead, diff the whole value.
    bridge.addEventListener('input', () => {
        if (is_editing) return;
        if (!socket_obj || socket_obj.readyState !== 1) return;

        // Avoid sending from the bridge unless it's actually the focused input.
        // This prevents rare Firefox focus glitches from duplicating keystrokes.
        try {
            if (document.activeElement !== bridge) return;
        } catch (e) {}

        const v = (bridge.value || "");

        // Some mobile keyboards insert a newline character instead of firing keydown.
        if (v.includes("\n") || v.includes("\r")) {
            // Send any text before the newline, then submit.
            const before = v.replace(/[\r\n]+/g, "");
            if (before) {
                const toSend = (koic_titlecase_active && !password_echo) ? koicTitlecaseWords(before) : before;
                if (local_echo || password_echo) {
                    for (const ch of toSend) term_obj.write(password_echo ? "." : ch);
                }
                socket_obj.send(toSend);
            }
            bridgeSendEnter();
            return;
        }

        const prev = bridge_last;
        if (v === prev) return;

        // Case 1: append
        if (v.startsWith(prev)) {
            const added = v.slice(prev.length);
            if (added) {
                const toSend = (koic_titlecase_active && !password_echo) ? koicTitlecaseApplyForAppend(prev, added) : added;
                if (local_echo || password_echo) {
                    for (const ch of toSend) {
                        if (ch === "\n" || ch === "\r") term_obj.write("\r\n");
                        else term_obj.write(password_echo ? "." : ch);
                    }
                }
                socket_obj.send(toSend);
            }
            bridge_last = v;
            // Mirror typed value into reading-pane cmd-line when local echo is active.
            if (pane_active && local_echo && !password_echo && pane_inline_echo_base) setPaneInlineEchoRawValue(v);
            return;
        }

        // Case 2: delete
        if (prev.startsWith(v)) {
            const delCount = prev.length - v.length;
            if (delCount > 0) {
                if (local_echo || password_echo) {
                    for (let i = 0; i < delCount; i++) term_obj.write("\b \b");
                }
                socket_obj.send("\b".repeat(delCount));
            }
            bridge_last = v;
            if (pane_active && local_echo && !password_echo && pane_inline_echo_base) setPaneInlineEchoRawValue(v);
            return;
        }

        // Case 3: replacement (IME / autocorrect). Best-effort: erase old then type new.
        if (prev.length) {
            if (local_echo || password_echo) {
                for (let i = 0; i < prev.length; i++) term_obj.write("\b \b");
            }
            socket_obj.send("\b".repeat(prev.length));
        }
        if (v.length) {
            const toSend = (koic_titlecase_active && !password_echo) ? koicTitlecaseWords(v) : v;
            if (local_echo || password_echo) {
                for (const ch of toSend) term_obj.write(password_echo ? "." : ch);
            }
            socket_obj.send(toSend);
        }
        bridge_last = v;
        if (pane_active && local_echo && !password_echo && pane_inline_echo_base) setPaneInlineEchoRawValue(v);
    });

    bridge.addEventListener('keydown', (e) => {
        if (is_editing) return;
        if (!socket_obj || socket_obj.readyState !== 1) return;

        // Handle Enter reliably (Android sometimes doesn't emit a useful `input` delta).
        if (e.key === 'Enter' || e.keyCode === 13) {
            e.preventDefault();
            bridgeSendEnter();
            return;
        }
    });

    // Some Android IMEs emit beforeinput insertLineBreak but not keydown.
    bridge.addEventListener('beforeinput', (e) => {
        if (is_editing) return;
        if (!socket_obj || socket_obj.readyState !== 1) return;
        if (e && e.inputType === 'insertLineBreak') {
            e.preventDefault();
            bridgeSendEnter();
        }
    });

    if (window.visualViewport) window.visualViewport.addEventListener('resize', handleResize);
    if (window.visualViewport) window.visualViewport.addEventListener('scroll', handleResize);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            scrollAllToBottom();
        });
    }
    bridge.addEventListener('focus', () => { scheduleKeyboardResize(); });
    bridge.addEventListener('blur', () => { scheduleKeyboardResize(); });

    // Desktop (Firefox responsive): keep terminal focused for hardware keyboard.
    // On touch devices, avoid auto-focus so we don't pop the soft keyboard while reading.
    if (!isTouchLike()) {
        document.addEventListener('click', () => focusTerminal(), true);
        document.addEventListener('keydown', () => focusTerminal(), true);
        focusTerminal();
    }

    koic_terminal_initialized = true;
}

function handleResize() {
    const vv = window.visualViewport;
    const vTop = (vv && typeof vv.offsetTop === 'number') ? vv.offsetTop : 0;
    const viewH = (vv && vv.height) ? vv.height : window.innerHeight;
    const vBottomInset = (vv && vv.height) ? Math.max(0, window.innerHeight - (vv.height + (vv.offsetTop || 0))) : 0;

    // Cache inset when the browser reports it (used only for keyboard visibility heuristics).
    if (vBottomInset > 0) last_keyboard_inset = Math.max(last_keyboard_inset, vBottomInset);

    const keyboardVisible = isSoftKeyboardVisible();
    // IMPORTANT: if visualViewport.height already shrank (vBottomInset>0), then `viewH`
    // is already the visible area above the keyboard; do not subtract again.
    // Only subtract an inset when the keyboard overlays content and the viewport doesn't shrink.
    let keyboardInset = 0;
    if (keyboardVisible) {
        if (vk_inset > 0) keyboardInset = vk_inset;
        else if (vBottomInset > 0) keyboardInset = 0;
        else keyboardInset = Math.max(0, last_keyboard_inset);
    }

    const nb = document.getElementById('mobile-nav-bar');
    // Keep the bar in its usual fixed place; hide it while keyboard is up.
    if (nb) nb.style.bottom = '0px';
    applyNextBarVisibility(true);

    const container = document.getElementById('terminal-container');
    if (container) container.style.top = vTop + 'px';
    const editor = document.getElementById('editor-overlay');
    if (editor) editor.style.top = vTop + 'px';

    const nbVisible = (!is_editing && nb && nb.style.display !== 'none');
    const nbH = nbVisible ? (nb.offsetHeight || 0) : 0;
    // Size to the *visual viewport* so content never sits under the keyboard.
    const availH = Math.max(0, viewH - keyboardInset);
    const paneHeight = Math.max(0, availH - nbH);

    document.getElementById('terminal-container').style.height = availH + "px";
    document.getElementById('editor-overlay').style.height = availH + "px";
    const pane = document.getElementById('reading-pane');
    let paneWasAtBottom = false;
    let panePrevScrollTop = 0;
    if (pane) {
        panePrevScrollTop = pane.scrollTop || 0;
        paneWasAtBottom = ((pane.scrollHeight - pane.scrollTop - pane.clientHeight) < 24);
        // Pane is positioned within the terminal container; don't pin to viewport.
        pane.style.height = paneHeight + "px";
    }
    // Approximate row height from tfont size (xterm lineHeight is ~1.2-1.3x).
    const fs = Number(clientCfg?.fontSize) || 15;
    const rowPx = Math.max(16, Math.round(fs * 1.25));
    if (term_obj) {
        term_obj.resize(TERM_COLS, Math.floor((availH - nbH) / rowPx));

        // Defer auto-fit checks until xterm has updated DOM/layout.
        requestAnimationFrame(() => {
            // Prefer keeping your chosen font size and widening the centered frame
            // (leaves side gutters) so we reliably get all 40 columns.
            tryAutoFitFrameWidth();

            // If we're still short on pixels (e.g. tiny viewport), fall back to
            // shrinking the font size just enough to fit all 40 columns.
            tryAutoFit40Cols();

            updateDebugHud();
        });
    }

    // Keep the reading pane anchored to bottom across keyboard show/hide,
    // but only if the user was already at bottom.
    if (pane) {
        requestAnimationFrame(() => {
            try {
                const maxTop = Math.max(0, (pane.scrollHeight - pane.clientHeight));
                if (paneWasAtBottom) pane.scrollTop = pane.scrollHeight;
                else pane.scrollTop = Math.min(panePrevScrollTop, maxTop);
            } catch (e) {}
        });
    }
    window.scrollTo(0, 0);
}

function isDebugHudEnabled() {
    try { return localStorage.getItem(KOIC_DEBUG_KEY) === '1'; } catch (e) { return false; }
}

function toggleDebugHud() {
    const next = !isDebugHudEnabled();
    try { localStorage.setItem(KOIC_DEBUG_KEY, next ? '1' : '0'); } catch (e) {}
    updateDebugHud();
}

function updateDebugHud() {
    const hud = document.getElementById('koic-debug-hud');
    if (!hud) return;

    const enabled = isDebugHudEnabled();
    hud.style.display = enabled ? 'block' : 'none';
    if (!enabled) return;

    const frameRaw = (getComputedStyle(document.documentElement).getPropertyValue('--koic-frame-width') || '').trim();
    const container = document.getElementById('terminal-container');
    const termEl = document.getElementById('terminal');
    const vp = getXtermViewportEl();
    const row = getXtermFirstRowEl();
    const dpr = (window.devicePixelRatio || 1);

    const rowRectW = row ? Math.round(((row.getBoundingClientRect()?.width || 0) * 100)) / 100 : 0;
    const rowStyleW = row ? (row.style.width || '') : '';
    const rowScrollW = row ? (row.scrollWidth || 0) : 0;
    const rowClientW = row ? (row.clientWidth || 0) : 0;

    const vpClient = vp ? (vp.clientWidth || 0) : 0;
    const vpOffset = vp ? (vp.offsetWidth || 0) : 0;
    const sbw = Math.max(0, vpOffset - vpClient);

    const cellW = term_obj?._core?._renderService?.dimensions?.actualCellWidth;
    const cellH = term_obj?._core?._renderService?.dimensions?.actualCellHeight;

    const vv = window.visualViewport;
    const vvH = (vv && vv.height) ? Math.round(vv.height) : 0;
    const vvTop = (vv && typeof vv.offsetTop === 'number') ? Math.round(vv.offsetTop) : 0;
    const vvInset = Math.round(getVisualViewportBottomInset());
    let ae = '';
    try {
        const el = document.activeElement;
        if (el) ae = (el.tagName || '') + (el.id ? ('#' + el.id) : '');
    } catch (e) {}

    let paneGeom = '';
    try {
        const pane = document.getElementById('reading-pane');
        const cont = document.getElementById('terminal-container');
        const pb = pane ? pane.getBoundingClientRect() : null;
        const cb = cont ? cont.getBoundingClientRect() : null;
        const vvBottom = (vv && typeof vv.offsetTop === 'number' && vv && vv.height) ? (vv.offsetTop + vv.height) : window.innerHeight;
        const pBottom = pb ? Math.round(pb.bottom) : -1;
        const pTop = pb ? Math.round(pb.top) : -1;
        const pH = pane ? (pane.clientHeight || 0) : 0;
        const cBottom = cb ? Math.round(cb.bottom) : -1;
        const cTop = cb ? Math.round(cb.top) : -1;
        const cH = cont ? (cont.clientHeight || 0) : 0;
        const overlap = (pBottom >= 0) ? Math.round(pBottom - vvBottom) : 0;
        paneGeom = `geom: pane=${pTop}-${pBottom} h=${pH}  cont=${cTop}-${cBottom} h=${cH}  vvBottom=${Math.round(vvBottom)}  ov=${overlap}`;
    } catch (e) {}

    hud.textContent = [
        `KOIC v${KOIC_VERSION} debug`,
        `win: ${window.innerWidth}x${window.innerHeight}  dpr=${dpr}`,
        `vv: h=${vvH} top=${vvTop} inset=${vvInset}  vk=${Math.round(vk_inset)} lastKb=${Math.round(last_keyboard_inset)} ae=${ae}`,
        paneGeom,
        (last_cmd_candidate ? (`cmd: ${String(last_cmd_candidate).slice(0, 120)}`) : ''),
        (last_tail_prompt ? (`prompt: ${String(last_tail_prompt).slice(0, 120)}`) : ''),
        `frame: ${frameRaw}  containerW=${container?.clientWidth || 0}`,
        `termW=${termEl?.clientWidth || 0}  vpClient=${vpClient}  vpOffset=${vpOffset}  sbw=${sbw}`,
        `rowRectW=${rowRectW}  rowClient=${rowClientW}  rowScroll=${rowScrollW}  rowStyleW=${rowStyleW}`,
        `xterm: cols=${term_obj?.cols || 0} rows=${term_obj?.rows || 0}  cell=${cellW ? cellW.toFixed(3) : '?'}x${cellH ? cellH.toFixed(3) : '?'}`,
        `Toggle: Ctrl+Alt+D`,
    ].filter(Boolean).join('\n');
}

function scheduleFontRemeasure() {
    // Multiple passes: immediate, after fonts ready (if supported), and timed fallbacks.
    setTimeout(() => { try { handleResize(); } catch (e) {} }, 0);
    try {
        if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
            document.fonts.ready.then(() => {
                try { handleResize(); } catch (e) {}
            });
        }
    } catch (e) {}
    setTimeout(() => { try { handleResize(); } catch (e) {} }, 250);
    setTimeout(() => { try { handleResize(); } catch (e) {} }, 800);
}

function getXtermViewportEl() {
    const termEl = document.getElementById('terminal');
    if (!termEl) return null;
    return termEl.querySelector('.xterm-viewport') || null;
}

function getXtermFirstRowEl() {
    const termEl = document.getElementById('terminal');
    if (!termEl) return null;
    return termEl.querySelector('.xterm-rows > div') || null;
}

function measureXtermRowWidthPx() {
    const row = getXtermFirstRowEl();
    if (!row) return 0;
    try {
        const rect = row.getBoundingClientRect();
        if (rect && rect.width && rect.width > 0) return Math.ceil(rect.width);
    } catch (e) {}
    const sw = row.scrollWidth || 0;
    return sw > 0 ? Math.ceil(sw) : 0;
}

function tryAutoFitFrameWidth() {
    if (_koic_frame_autofit_busy) return;
    if (!term_obj) return;

    const vp = getXtermViewportEl();
    if (!vp) return;

    // Prefer the DOM-reported row width. This reflects the exact inline width
    // xterm applies (and avoids internal rounding discrepancies).
    const rowW = measureXtermRowWidthPx();
    if (!rowW || rowW <= 0) return;

    // Width needed for the *text* area (not including scrollbar).
    const safety = 4; // extra pixels to avoid last-column clipping (DPR rounding)
    const neededText = rowW + safety;

    // Scrollbar width, if present.
    const sbw = Math.max(0, (vp.offsetWidth || 0) - (vp.clientWidth || 0));

    const neededFrame = neededText + sbw + 2;
    const maxFrame = Math.floor(window.innerWidth || document.documentElement.clientWidth || neededFrame);
    const target = Math.min(neededFrame, maxFrame);

    const curRaw = getComputedStyle(document.documentElement).getPropertyValue('--koic-frame-width') || '380px';
    const cur = parseInt(curRaw, 10) || 380;

    // Only increase width; don't oscillate.
    if (target > cur + 1 && target <= maxFrame) {
        _koic_frame_autofit_busy = true;
        try {
            document.documentElement.style.setProperty('--koic-frame-width', target + 'px');
        } catch (e) {}
        setTimeout(() => {
            _koic_frame_autofit_busy = false;
            try { handleResize(); } catch (e) {}
        }, 0);
    }
}

function tryAutoFit40Cols() {
    if (_koic_autofit_busy) return;
    if (!term_obj) return;
    const termEl = document.getElementById('terminal');
    if (!termEl) return;

    // Use xterm's viewport width (text area), not the outer terminal div.
    const vp = getXtermViewportEl();
    const avail = (vp ? vp.clientWidth : termEl.clientWidth) || 0;
    if (avail <= 0) return;

    // Compare against the real row width that xterm is trying to paint.
    const rowW = measureXtermRowWidthPx();
    if (!rowW || rowW <= 0) return;
    const slack = 2; // px safety margin
    if (rowW <= (avail - slack)) return;

    const curFs = Number(term_obj.getOption('fontSize')) || 15;
    if (curFs <= 12) return;

    _koic_autofit_busy = true;
    try {
        term_obj.setOption('fontSize', curFs - 1);
        // Let xterm re-measure then re-run once.
        setTimeout(() => {
            _koic_autofit_busy = false;
            try { handleResize(); } catch (e) {}
        }, 0);
    } catch (e) {
        _koic_autofit_busy = false;
    }
}

function connect() {
    // Don't open a second socket if we're already connected/connecting.
    try {
        if (socket_obj && (socket_obj.readyState === 0 || socket_obj.readyState === 1)) return;
    } catch (e) {}

    socket_obj = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/bbs');
    socket_obj.onopen = () => {
        if (!isTouchLike()) focusTerminal();
        updateDebugHud();
        // Keepalive ping -- prevents reverse-proxy idle timeout.
        clearInterval(ws_ping_timer);
        ws_ping_timer = setInterval(() => {
            if (socket_obj && socket_obj.readyState === 1) {
                try { socket_obj.send('__PING__'); } catch (e) {}
            }
        }, 150000);

        // Always inform the server of our current prefs at connect time.
        try {
            socket_obj.send('__SET_ANSI__:' + (clientCfg.ansi ? '1' : '0'));
            socket_obj.send('__LOGIN__:' + (clientCfg.loginUser || ''));
            socket_obj.send('__ENEMIES__:' + (clientCfg.enemies || ''));
        } catch (e) {}

        // Arm autologin for this session (password will be sent on first password prompt).
        autoLoginArmed = !!(clientCfg.autoLogin && clientCfg.loginUser);
    };
    socket_obj.onmessage = async (e) => {
        const buffer = (e.data instanceof ArrayBuffer) ? e.data : await e.data.arrayBuffer();
        let text = new TextDecoder().decode(buffer);

        if (text.startsWith('__CLIENT_CONFIG__')) {
            // BBS-triggered client-config hook (e.g. "cc").
            // Open KOIC's local config modal.
            openClientConfig();
            return;
        }

        // NOTE: __AWAITING_NAME__/__PASSWORD_MODE__/__MORE_PROMPT__/__AUTOLOGIN_ECHO_NAME__ are
        // handled inline at the byte level so they never render in the terminal.

        if (text === '__COMPOSE_START__') {
            draft_edit_mode = false;
            try {
                const sp = document.getElementById('scratchpad');
                if (sp) sp.value = '';
            } catch (e) {}
            showEditor();
            ariaAnnounce('Compose editor open. Type your message, then tap POST.', true);
            return;
        }
        if (text === '__POST_MENU__') {
            post_menu = true;
            return;
        }
        if (text === '__POST_MENU_END__') {
            post_menu = false;
            return;
        }
        if (text === '__POST_MENU_PROMPT__') {
            writePostMenuPrompt();
            return;
        }
        if (text.startsWith('__FIVE_START__:')) {
            try {
                awaiting_five = true;
                five_which = Number(text.slice('__FIVE_START__:'.length)) || 0;
                // Ensure typing is visible and not double-interpreted.
                forcedInput = null;
                password_echo = false;
                local_echo = true;
                post_menu = false;

                // While in five-line entry, prefer the raw terminal (reading pane can hide local echo).
                five_prev_pane_active = !!pane_active;
                if (pane_active) {
                    pane_active = false;
                    const pane = document.getElementById('reading-pane');
                    if (pane) pane.style.display = 'none';
                    setNextBarVisible(false);
                }

                term_obj.write("\r\n>");
                focusTerminal();
                updateDebugHud();
            } catch (e) {}
            return;
        }
        if (text === '__FIVE_PROMPT__') {
            try {
                term_obj.write('>');
                focusTerminal();
                updateDebugHud();
            } catch (e) {}
            return;
        }
        if (text === '__FIVE_END__') {
            try {
                awaiting_five = false;
                five_which = 0;
                local_echo = false;
                password_echo = false;

                // Restore reading pane if it was previously active.
                if (five_prev_pane_active && clientCfg?.useReadingPane) {
                    pane_active = true;
                    const pane = document.getElementById('reading-pane');
                    if (pane) pane.style.display = 'block';
                }
                five_prev_pane_active = false;

                try { checkGate(); } catch (e) {}
                try {
                    if (pane_active) {
                        updateReadingPane();
                        renderPaneInlineEcho();
                    }
                } catch (e) {}
                updateDebugHud();
            } catch (e) {}
            return;
        }
        // __MORE_PROMPT__ handled inline.
        if (text.startsWith('__EDIT_DRAFT__:')) {
            const b64 = text.slice('__EDIT_DRAFT__:'.length);
            try {
                const binStr = atob(b64);
                const bytes = new Uint8Array(binStr.length);
                for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
                const draft = new TextDecoder().decode(bytes);
                document.getElementById('scratchpad').value = draft;
                draft_edit_mode = true;
                showEditor();
            } catch (err) {}
            return;
        }
        if (text.startsWith('__DRAFT_RENDER__:')) {
            const b64 = text.slice('__DRAFT_RENDER__:'.length);
            try {
                const binStr = atob(b64);
                const bytes = new Uint8Array(binStr.length);
                for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
                const draft = new TextDecoder().decode(bytes);
                term_obj.write("\r\n" + draft.replace(/\n/g, "\r\n") + "\r\n", () => {
                    writePostMenuPrompt();
                });
            } catch (err) {}
            return;
        }

        const filtered = koicFilterAndHandleControlBytes(new Uint8Array(buffer));
        if (!filtered || filtered.length === 0) {
            // Still run gate checks after control messages.
            checkGate();
            updateDebugHud();
            if (!isTouchLike()) focusTerminal();
            return;
        }

        term_obj.write(filtered, () => {
            checkGate();
            updateDebugHud();
            // Post-render focus helps prevent "no keyboard focus" in Firefox responsive mode.
            if (!isTouchLike()) focusTerminal();
        });
    };
    socket_obj.onclose = () => {
        clearInterval(ws_ping_timer);
        ws_ping_timer = null;
        document.getElementById('start-overlay').style.display = 'flex';
        document.getElementById('connect-btn').innerText = "RECONNECT";
        try { socket_obj = null; } catch (e) {}
    };
}

function escapeHTML(str) {
    return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#039;"}[m]));
}

function stripANSI(str) { 
    let clean = str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    return clean.replace(/[^\x20-\x7E]/g, '');
}

// --- Reading pane ANSI renderer ---
// When ANSI is enabled, the BBS can use SGR attributes (colors, bold, underline).
// xterm stores these per-cell; translateToString() loses them.
const KOIC_PANE_DEFAULT_FG = '#33FF33';
const KOIC_PANE_DEFAULT_BG = '#000000';

// xterm.js default 16-color palette (matches its built-in defaults).
const KOIC_ANSI16 = [
    '#2e3436', '#cc0000', '#4e9a06', '#c4a000',
    '#3465a4', '#75507b', '#06989a', '#d3d7cf',
    '#555753', '#ef2929', '#8ae234', '#fce94f',
    '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
];

const _koic_ansi256_cache = new Array(256);
function koicAnsiIndexToCss(idx) {
    const i = Number(idx);
    if (!Number.isFinite(i) || i < 0 || i > 255) return '';
    const cached = _koic_ansi256_cache[i];
    if (cached) return cached;

    let css;
    if (i < 16) {
        css = KOIC_ANSI16[i];
    } else if (i >= 16 && i <= 231) {
        const n = i - 16;
        const r = Math.floor(n / 36);
        const g = Math.floor((n % 36) / 6);
        const b = n % 6;
        const steps = [0, 95, 135, 175, 215, 255];
        css = `rgb(${steps[r]},${steps[g]},${steps[b]})`;
    } else {
        const level = 8 + (i - 232) * 10;
        css = `rgb(${level},${level},${level})`;
    }

    _koic_ansi256_cache[i] = css;
    return css;
}

function koicRgb24ToCss(rgb24) {
    const n = Number(rgb24) >>> 0;
    const hex = (n & 0xFFFFFF).toString(16).padStart(6, '0');
    return '#' + hex;
}

function koicEscapeHtml(str) {
    return escapeHTML(String(str || '')).replace(/\n/g, '');
}

function koicCellStyleKey(cell) {
    // Build a compact stable key for caching span styles.
    try {
        const inverse = !!cell.isInverse?.();
        const bold = !!cell.isBold?.();
        const italic = !!cell.isItalic?.();
        const dim = !!cell.isDim?.();
        const underline = !!cell.isUnderline?.();
        const strike = !!cell.isStrikethrough?.();
        const invisible = !!cell.isInvisible?.();

        const fgMode = cell.getFgColorMode?.() || 0;
        const bgMode = cell.getBgColorMode?.() || 0;
        const fg = cell.getFgColor?.();
        const bg = cell.getBgColor?.();
        return [fgMode, fg, bgMode, bg, inverse ? 1 : 0, bold ? 1 : 0, italic ? 1 : 0, dim ? 1 : 0, underline ? 1 : 0, strike ? 1 : 0, invisible ? 1 : 0].join(',');
    } catch (e) {
        return '0';
    }
}

const _koic_pane_style_cache = new Map();
function koicStyleForCell(cell) {
    const key = koicCellStyleKey(cell);
    const cached = _koic_pane_style_cache.get(key);
    if (cached) return cached;

    let fgCss = KOIC_PANE_DEFAULT_FG;
    let bgCss = KOIC_PANE_DEFAULT_BG;

    try {
        const inverse = !!cell.isInverse?.();
        const bold = !!cell.isBold?.();
        const italic = !!cell.isItalic?.();
        const dim = !!cell.isDim?.();
        const underline = !!cell.isUnderline?.();
        const strike = !!cell.isStrikethrough?.();
        const invisible = !!cell.isInvisible?.();

        const fgMode = cell.getFgColorMode?.() || 0;
        const bgMode = cell.getBgColorMode?.() || 0;

        // Palette/256color vs RGB vs default.
        if (fgMode === 16777216 || fgMode === 33554432) {
            let idx = Number(cell.getFgColor?.());
            // Approximate xterm's drawBoldTextInBrightColors behavior.
            if (bold && idx >= 0 && idx < 8) idx += 8;
            fgCss = koicAnsiIndexToCss(idx) || fgCss;
        } else if (fgMode === 50331648) {
            fgCss = koicRgb24ToCss(cell.getFgColor?.());
        }

        if (bgMode === 16777216 || bgMode === 33554432) {
            bgCss = koicAnsiIndexToCss(cell.getBgColor?.()) || bgCss;
        } else if (bgMode === 50331648) {
            bgCss = koicRgb24ToCss(cell.getBgColor?.());
        }

        if (inverse) {
            const t = fgCss;
            fgCss = bgCss;
            bgCss = t;
        }

        // Only set color/background when needed. This lets elements like `.post-header`
        // provide their own base colors while still allowing explicit ANSI colors.
        let style = '';
        if (inverse || fgCss !== KOIC_PANE_DEFAULT_FG) style += `color:${fgCss};`;
        if (inverse || bgCss !== KOIC_PANE_DEFAULT_BG) style += `background-color:${bgCss};`;
        if (bold) style += 'font-weight:700;';
        if (italic) style += 'font-style:italic;';
        if (underline && strike) style += 'text-decoration:underline line-through;';
        else if (underline) style += 'text-decoration:underline;';
        else if (strike) style += 'text-decoration:line-through;';
        if (dim) style += 'opacity:0.7;';
        if (invisible) style += 'color:transparent;';

        _koic_pane_style_cache.set(key, style);
        return style;
    } catch (e) {
        const style = `color:${fgCss};background-color:${bgCss};`;
        _koic_pane_style_cache.set(key, style);
        return style;
    }
}

function koicBufferLineToAnsiHtml(lineObj, cols) {
    if (!lineObj) return '';

    const maxCols = Number(cols) || WRAP_COLS;
    // Find last non-space character so we can trim right (like the plain renderer).
    let lastSigCol = -1;
    try {
        const workCell = term_obj?.buffer?.active?.getNullCell?.();
        if (workCell) {
            for (let x = 0; x < maxCols; x++) {
                const cell = lineObj.getCell(x, workCell);
                if (!cell) continue;
                if (cell.getWidth && cell.getWidth() === 0) continue;
                const ch = cell.getChars ? (cell.getChars() || ' ') : ' ';
                if (ch && ch !== ' ') lastSigCol = x;
            }
        }
    } catch (e) {}

    if (lastSigCol < 0) return '';

    let html = '';
    let runStyle = '';
    let runText = '';

    try {
        const workCell = term_obj?.buffer?.active?.getNullCell?.();
        if (!workCell) return '';

        for (let x = 0; x <= lastSigCol && x < maxCols; x++) {
            const cell = lineObj.getCell(x, workCell);
            if (!cell) continue;
            const w = cell.getWidth ? cell.getWidth() : 1;
            if (w === 0) continue;
            const ch = cell.getChars ? (cell.getChars() || ' ') : ' ';
            const style = koicStyleForCell(cell);

            if (style !== runStyle) {
                if (runText) {
                    html += `<span style="${runStyle}">${koicEscapeHtml(runText)}</span>`;
                }
                runStyle = style;
                runText = '';
            }
            runText += ch;
        }
        if (runText) {
            html += `<span style="${runStyle}">${koicEscapeHtml(runText)}</span>`;
        }
    } catch (e) {
        // Fallback: plain text.
        try {
            const t = stripANSI(lineObj.translateToString(true) || '');
            html = koicEscapeHtml(t);
        } catch (err) {
            html = '';
        }
    }

    return html;
}

function koicLineHasSpaceAtCol(lineObj, col) {
    try {
        if (!lineObj) return false;
        const x = Number(col);
        if (!Number.isFinite(x) || x < 0) return false;
        const workCell = term_obj?.buffer?.active?.getNullCell?.();
        if (!workCell) return false;
        const cell = lineObj.getCell(x, workCell);
        if (!cell) return false;
        const w = cell.getWidth ? cell.getWidth() : 1;
        if (w === 0) return false;
        const ch = cell.getChars ? (cell.getChars() || ' ') : ' ';
        return ch === ' ';
    } catch (e) {
        return false;
    }
}

function getCmdCandidateForPane(buffer, endIndex) {
    // Reconstruct the wrapped prompt/command line at the cursor.
    let cmdStart = endIndex;
    while (cmdStart > 0 && buffer.getLine(cmdStart)?.isWrapped) cmdStart--;
    let cmdCandidate = '';
    if (cmdStart <= endIndex) {
        const parts = [];
        for (let j = cmdStart; j <= endIndex; j++) {
            const raw = stripANSI(buffer.getLine(j)?.translateToString(false) || '');
            const endsWithSpace = /[ \t]$/.test(raw);
            const startsWithSpace = /^[ \t]/.test(raw);
            const t = raw.replace(/[ \t]+$/g, '');
            if (!t) continue;
            parts.push({ text: t, endsWithSpace, startsWithSpace });
        }
        let joined = '';
        let prevEndsWithSpace = false;
        for (let i = 0; i < parts.length; i++) {
            const seg = parts[i];
            const txt = seg.text;
            if (!joined) {
                joined = txt.trim();
                prevEndsWithSpace = !!seg.endsWithSpace;
                continue;
            }
            const prevLastCh = joined.length ? joined[joined.length - 1] : '';
            const nextFirstCh = txt.length ? txt[0] : '';
            const joinNoSpace = (
                !prevEndsWithSpace
                && !seg.startsWithSpace
                && /[A-Za-z0-9]/.test(prevLastCh)
                // Avoid gluing lines like "e" + "Enter message" into "eEnter".
                // Split-word wraps rarely begin with an uppercase letter.
                && /[a-z0-9]/.test(nextFirstCh)
            );
            joined += (joinNoSpace ? '' : ' ') + txt.trim();
            prevEndsWithSpace = !!seg.endsWithSpace;
        }
        cmdCandidate = joined.replace(/\s+/g, ' ').trim();

        // If we captured both a "Read cmd ->" tail and a compose prompt, prefer the compose prompt.
        // This can happen when the user's typed command wraps at the right edge.
        const enterIdx = cmdCandidate.toLowerCase().indexOf('enter message');
        if (enterIdx >= 0 && /read cmd\s*->/i.test(cmdCandidate)) {
            cmdCandidate = cmdCandidate.slice(enterIdx).trim();
        }
    }

    const isCmdCandidate = /\b(Read cmd ->|-- More --|Lobby>|Babble>|Mail>|Conf:|Jump\b|Skip\b|Search\b)\b|forum name\/number\?\s*->\s*$|->\s*$|:\s*$/i.test(cmdCandidate);
    return { cmdStart, cmdCandidate, isCmdCandidate };
}

    // BBS is negotiated as 40 columns (NAWS/DOC config), but on some HiDPI setups
    // the 40th glyph can get clipped at the right edge due to subpixel rounding.
    // Render 1 extra "ghost" column so the BBS's 40th column isn't at the edge.
    const BBS_COLS = 40;
    const TERM_COLS = 41;
    const WRAP_COLS = BBS_COLS;

function wrapToCols(text, cols = WRAP_COLS) {
    text = (text || "").replace(/\r/g, "");
    text = stripANSI(text);
    text = text.replace(/\s+/g, " ").trim();
    if (!text) return "";

    const words = text.split(' ');
    const lines = [];
    let line = '';

    function pushWord(w) {
        if (!w) return;
        // Break very long tokens (URLs etc.) so we never overflow.
        while (w.length > cols) {
            const part = w.slice(0, cols);
            w = w.slice(cols);
            if (line) { lines.push(line); line = ''; }
            lines.push(part);
        }
        if (!line) {
            line = w;
            return;
        }
        if (line.length + 1 + w.length <= cols) {
            line += ' ' + w;
        } else {
            lines.push(line);
            line = w;
        }
    }

    for (const w of words) pushWord(w);
    if (line) lines.push(line);

    // Reduce short "hanger" lines by pulling one word down when possible.
    // This is a post-pass on the greedy wrap.
    const minHanger = 9;
    for (let pass = 0; pass < 2; pass++) {
        for (let i = lines.length - 1; i > 0; i--) {
            const cur = lines[i];
            const prev = lines[i - 1];
            if (!cur || !prev) continue;
            if (cur.length >= minHanger) continue;
            if (!prev.includes(' ')) continue;

            const parts = prev.split(' ');
            if (parts.length < 2) continue;
            const moved = parts.pop();
            const newPrev = parts.join(' ');
            const newCur = moved + ' ' + cur;

            if (newPrev.length < minHanger) continue;
            if (newPrev.length > cols) continue;
            if (newCur.length > cols) continue;

            lines[i - 1] = newPrev;
            lines[i] = newCur;
        }
    }
    return lines.join("\n");
}

function panePointerDown(e) {
    // On touch-like devices, do not steal focus on scroll gestures.
    if (isTouchLike()) return;
    if (clientCfg?.selectionMode) return;
    focusTerminal();
}

function paneClick(e) {
    try {
        const sel = window.getSelection && window.getSelection();
        if (sel && String(sel).length > 0) return;
    } catch (err) {}
    if (isTouchLike()) return;
    if (clientCfg?.selectionMode) return;
    focusTerminal();
}

function cmdLineClick(e) {
    try { if (e) e.stopPropagation(); } catch (err) {}
    // Cmd-line is the intentional "tap to type" area.
    focusTerminal();
}

function checkGate() {
    const buffer = term_obj.buffer.active;
    let showPane = false;
    at_command_prompt = false; 

    const cursorIndex = buffer.baseY + buffer.cursorY;

    // Prompts can wrap (e.g. "Jump to forum name/number? ->"), so examine a small tail
    // across multiple physical lines.
    const l0 = stripANSI(buffer.getLine(cursorIndex)?.translateToString() || "");
    const l1 = stripANSI(buffer.getLine(cursorIndex - 1)?.translateToString() || "");
    const l2 = stripANSI(buffer.getLine(cursorIndex - 2)?.translateToString() || "");
    const tailPrompt = (l2 + ' ' + l1 + ' ' + l0).replace(/\s+/g, ' ').trim();
    last_tail_prompt = tailPrompt;
    // Reconstruct the wrapped prompt/command line at the cursor (more reliable than the 3-line tail).
    let cmdCandidate = '';
    try {
        const r = getCmdCandidateForPane(buffer, cursorIndex);
        cmdCandidate = r?.cmdCandidate || '';
    } catch (e) {}
    last_cmd_candidate = cmdCandidate;

    const promptText = (cmdCandidate || tailPrompt);
    const forumPrompt = /\bforum\b.*(?:name|number|#)?\b.*(?:\?\s*->|->|:\s*$|\?\s*$)/i.test(promptText);
    const isInputMode = /Jump\b|Skip\b|Search\b|Name:|User:|Password:|Subject:|File:|Enter\b|\?|->|:\s*$/i.test(promptText) || forumPrompt;

    const needsTextEntry = /(Jump\b|Skip\b|Search\b|Name:|User:|Password:|Subject:|File:|Enter\b|forum name\/number\?\s*->)/i.test(promptText) || forumPrompt;
    if (needsTextEntry && !is_editing && !post_menu) {
        // Prompt wants input: ensure keyboard focus.
        focusTerminal();
    }

    // Enable local echo where the DOC server often does not echo (mobile UX).
    // Prefer a broad heuristic for any explicit text-entry prompt; exclude passwords.
    const looksLikeTextPrompt = (
        /(?:\?\s*->\s*$|->\s*$|:\s*$|\?\s*$)/i.test(promptText)
        || /\bName:|\bUser:|\bSubject:|\bFile:/i.test(promptText)
    );
    local_echo = (!!(needsTextEntry || looksLikeTextPrompt) && !/\bPassword:\s*$/i.test(promptText));

    // Password entry: mask echo as '.' (do NOT echo actual characters).
    password_echo = /\bPassword:\s*$/i.test(l0);

    // Server-side DOC hints override prompt detection when present.
    if (forcedInput === 'NAME') {
        local_echo = true;
        password_echo = false;
        koic_titlecase_active = true;
    } else if (forcedInput === 'PASSWORD') {
        local_echo = false;
        password_echo = true;
        koic_titlecase_active = false;
    } else if (forcedInput === 'STR') {
        // G_STR non-password field: plain echo, no masking, no titlecase.
        local_echo = true;
        password_echo = false;
        koic_titlecase_active = false;
    } else {
        koic_titlecase_active = koicShouldTitlecasePrompt(promptText);
    }

    // Local post menu keys should not be echoed twice.
    if (post_menu) {
        local_echo = false;
        password_echo = false;
        koic_titlecase_active = false;
    }

    // Read-cmd hotkeys are echoed by the BBS; avoid double-echo.
    if (/\bRead cmd\s*->/i.test(promptText)) {
        local_echo = false;
        password_echo = false;
        koic_titlecase_active = false;
    }

    // Inline echo in reading pane: keep the cmd-line readable while typing.
    // Only for non-password prompts.
    if (pane_active && local_echo && !password_echo && (needsTextEntry || looksLikeTextPrompt)) {
        const bridge = document.getElementById('phantom-input');
        const cur = bridge ? (bridge.value || '') : '';
        if (pane_inline_echo_base !== promptText) {
            startPaneInlineEchoForPrompt(promptText, cur);
        } else {
            // Same prompt, just refresh from current bridge value.
            setPaneInlineEchoRawValue(cur);
        }
    } else {
        pane_inline_echo_base = '';
        pane_inline_echo_origin_raw = '';
        pane_inline_echo_raw = '';
        pane_inline_echo_value = '';
    }

    // Hint to some mobile keyboards / browsers.
    const bridge = document.getElementById('phantom-input');
    if (bridge) {
        const wantType = password_echo ? 'password' : 'text';
        if (bridge.type !== wantType) {
            bridge.type = wantType;
        }
    }

    let sawLobbyPrompt = false;
    for (let i = 0; i < 4; i++) {
        const line = stripANSI(buffer.getLine(buffer.baseY + buffer.cursorY - i)?.translateToString() || "");
        // Only activate the reading pane for reading contexts; keep the raw terminal visible
        // during general navigation prompts like Lobby>.
        if (/(Read cmd ->|-- More --)/i.test(line)) { 
            showPane = true; 
            if (!isInputMode) at_command_prompt = true; 
            editor_already_shown = false; 
        }

        // Bootstrap: show the reading pane once when we first hit the main Lobby prompt.
        // This avoids waiting for the first full-screen read/more prompt before the pane exists.
        if (!lobby_pane_bootstrapped && /Lobby>/i.test(line)) {
            sawLobbyPrompt = true;
        }
    }

    if (!lobby_pane_bootstrapped && sawLobbyPrompt) {
        showPane = true;
    }

    // One-shot: configure ANSI/colors at the first Lobby prompt.
    // If ANSI is enabled in client config, send: cty + RETURN.
    if (!lobby_cty_sent && sawLobbyPrompt && clientCfg?.ansi) {
        try {
            if (socket_obj?.readyState === 1 && !is_editing && !post_menu) {
                socket_obj.send('cty');
                socket_obj.send("\r\n");
                lobby_cty_sent = true;
            }
        } catch (e) {}
    }

    if (!clientCfg.useReadingPane) showPane = false;

    if (showPane && !pane_active) {
        pane_active = true;
        document.getElementById('reading-pane').style.display = 'block';
        // NEXT/SPACE bar can be toggled while pane is active.
        setNextBarVisible(!!clientCfg.showNextBar);

        if (!lobby_pane_bootstrapped && sawLobbyPrompt) {
            lobby_pane_bootstrapped = true;
        }
    }
    if (pane_active) {
        setNextBarVisible(!!clientCfg.showNextBar);
    } else {
        setNextBarVisible(false);
    }
    if (pane_active) updateReadingPane();
    if (pane_active) renderPaneInlineEcho();

    // Announce prompt text changes to screen readers.
    if (promptText && promptText !== _ariaLastPrompt) {
        _ariaLastPrompt = promptText;
        ariaAnnounce(promptText, true);
    }
}

function updateReadingPanePlain() {
    const buffer = term_obj.buffer.active, pane = document.getElementById('reading-pane');
    let htmlOut = "", currentPostLines = [], headerRegex = /([A-Z][a-z]{2}\s+\d+,\s+\d{4}\s+\d+:\d+).*from/i;

    // Preserve scroll position unless user is already at the bottom.
    const prevScrollTop = pane ? pane.scrollTop : 0;
    const wasAtBottom = pane ? ((pane.scrollHeight - pane.scrollTop - pane.clientHeight) < 24) : true;

    const endIndex = buffer.baseY + buffer.cursorY;

    // If the command/prompt line wraps, reconstruct it from the wrapped group.
    // Keep this logic centralized so it stays consistent with checkGate() and ANSI pane.
    const { cmdStart, cmdCandidate, isCmdCandidate } = getCmdCandidateForPane(buffer, endIndex);
    const loopEnd = (isCmdCandidate ? (cmdStart - 1) : endIndex);

    for (let i = 0; i <= loopEnd; i++) {
        const lineObj = buffer.getLine(i);
        // Preserve trailing spaces so we can decide whether to join with a space
        // when xterm wraps at a column boundary.
        let lineTextRaw = lineObj?.translateToString(false) || "";
        let lineText = stripANSI(lineTextRaw);
        const isWrapped = !!lineObj?.isWrapped;
        const endsWithSpace = /[ \t]$/.test(lineText);
        const startsWithSpace = /^[ \t]/.test(lineText);
        lineText = lineText.replace(/[ \t]+$/g, '');
        const nearWrap = (lineText.length >= WRAP_COLS);

        // If a bracketed room/status prompt wrapped across lines, stitch it back together
        // before applying prompt splitting logic.
        // Example physical wrap:
        //   "[Room> msg #123 (0 re"
        //   "maining)] Read cmd ->"
        if (currentPostLines.length > 0 && isWrapped) {
            const lastText = String(last?.text || '');
            const lastLooksLikeOpenBracketPrompt = (
                lastText.trimStart().startsWith('[')
                && lastText.includes('>')
                && !lastText.includes(']')
            );

            if (lastLooksLikeOpenBracketPrompt) {
                const joinNoSpace = (
                    !last.endsWithSpace
                    && !startsWithSpace
                    && /[A-Za-z0-9]$/.test(lastText)
                    && /^[A-Za-z0-9]/.test(lineText)
                );
                last.text = lastText + (joinNoSpace ? '' : ' ') + lineText;
                last.wrapped = true;
                last.endsWithSpace = endsWithSpace;
                last.nearWrap = !!nearWrap;
                continue;
            }
        }

        // General case: if xterm says this line is a wrapped continuation, merge it into
        // the previous logical line so prompts and words don't split like "Read c"/"md ->".
        if (currentPostLines.length > 0 && isWrapped) {
            const last = currentPostLines[currentPostLines.length - 1];
            const lastText = String(last?.text || '');
            if (lastText.trim() !== '') {
                const prevLastCh = lastText.length ? lastText[lastText.length - 1] : '';
                const nextFirstCh = lineText.length ? lineText[0] : '';
                const prevHardWrappedAtCol = !!last.nearWrap || (lastText.trimEnd().length >= (WRAP_COLS - 1));
                const joinNoSpace = (
                    (!last.endsWithSpace || prevHardWrappedAtCol)
                    && !startsWithSpace
                    && /[A-Za-z0-9]/.test(prevLastCh)
                    && /[A-Za-z0-9]/.test(nextFirstCh)
                );
                last.text = lastText + (joinNoSpace ? '' : ' ') + lineText;
                last.wrapped = true;
                last.endsWithSpace = endsWithSpace;
                last.nearWrap = !!nearWrap;
                continue;
            }
        }

        // Reading-pane-only splitting: keep prompts readable and prevent them from
        // sticking onto the end of the last post line.

        // 1) If a bracketed room status prompt appears mid-line, break it out.
        // Example: "... post text ... [The Mens Room> msg #... (0 Remaining)] Read cmd ->"
        const bracketPromptRe = /(\[[^\]]+>[^\]]*\])/;
        const bp = lineText.match(bracketPromptRe);
        if (bp) {
            const idx = bp.index || 0;
            const before = lineText.slice(0, idx).trimEnd();
            const bracket = bp[1] || '';
            const after = lineText.slice(idx + bracket.length).trimStart();

            if (before) {
                currentPostLines.push({ text: before, wrapped: isWrapped, endsWithSpace: endsWithSpace, startsWithSpace: startsWithSpace, nearWrap: (before.length >= WRAP_COLS) });
            }

            // Always force the bracket prompt onto its own logical line when present.
            if (bracket) {
                currentPostLines.push({ text: bracket, wrapped: false, endsWithSpace: false, startsWithSpace: false, nearWrap: (bracket.length >= WRAP_COLS) });
            }

            lineText = after;
        }

        // 2) Split classic prompts out if they appear mid-line.
        const promptRe = /\b(Lobby>|Babble>|Mail>|Read cmd ->)/i;
        const m = lineText.match(promptRe);
        if (m && m.index > 0) {
            const idx = m.index;
            const before = lineText.slice(0, idx).trimEnd();
            const after = lineText.slice(idx).trimStart();
            if (before) {
                currentPostLines.push({ text: before, wrapped: isWrapped, endsWithSpace: endsWithSpace, startsWithSpace: startsWithSpace, nearWrap: (before.length >= WRAP_COLS) });
            }
            lineText = after;
        }

        // 3) Read cmd: keep only "Read cmd ->" in footer; move any tail text into body.
        const rc = lineText.match(/^(.*?)(Read cmd ->)(\s+.*)?$/i);
        if (rc && rc[2]) {
            const pre = (rc[1] || '').trim();
            const tail = (rc[3] || '').trim();

            // If there is any pre-text (like a bracket prompt), render it as body above footer.
            if (pre) {
                currentPostLines.push({ text: pre, wrapped: false, endsWithSpace: false, startsWithSpace: false, nearWrap: (pre.length >= WRAP_COLS) });
            }
            // Preserve small tail hints like "Next"; they wrap poorly when split.
            lineText = 'Read cmd ->' + (tail ? (' ' + tail) : '');
        }
        if (lineText.match(headerRegex)) {
            if (currentPostLines.length > 0) htmlOut += "<div>" + healAndWrap(currentPostLines) + "</div>";
            currentPostLines = []; 
            htmlOut += '<div class="post-header">' + escapeHTML(wrapToCols(lineText)) + '</div>';
        } else {
            currentPostLines.push({ text: lineText, wrapped: isWrapped, endsWithSpace: endsWithSpace, startsWithSpace: startsWithSpace, nearWrap: !!nearWrap });
        }
    }

    // Flush body.
    if (currentPostLines.length > 0) htmlOut += "<div>" + healAndWrap(currentPostLines) + "</div>";

    // Render reconstructed command/prompt line, if detected.
    if (isCmdCandidate && cmdCandidate) {
        const base = (pane_inline_echo_base && (pane_inline_echo_base === cmdCandidate)) ? pane_inline_echo_base : cmdCandidate;
        const full = (pane_inline_echo_base && (pane_inline_echo_base === cmdCandidate))
            ? joinPromptAndValue(base, pane_inline_echo_value)
            : base;
        htmlOut += '<div class="cmd-line" onclick="cmdLineClick(event)">' + escapeHTML(wrapToCols(full)) + '</div>';
    }

    pane.innerHTML = htmlOut;
    schedulePaneLinkify();
    if (pane) {
        if (wasAtBottom) pane.scrollTop = pane.scrollHeight;
        else pane.scrollTop = prevScrollTop;
    }

    // Announce the cmd-line text to screen readers when it changes (polite).
    if (isCmdCandidate && cmdCandidate && cmdCandidate !== _ariaLastPaneCmd) {
        _ariaLastPaneCmd = cmdCandidate;
        ariaAnnounce(cmdCandidate);
    }
}

function updateReadingPaneAnsi() {
    const buffer = term_obj?.buffer?.active;
    const pane = document.getElementById('reading-pane');
    if (!buffer || !pane) return;

    let htmlOut = '';
    const headerRegex = /([A-Z][a-z]{2}\s+\d+,\s+\d{4}\s+\d+:\d+).*from/i;

    // xterm is configured with TERM_COLS (41) to avoid clipping the BBS's 40th column.
    // Use the actual terminal column count for reading buffer lines, or we can
    // drop characters/spaces that land in the extra "ghost" column.
    const paneCols = Math.max(1, Number(term_obj?.cols) || TERM_COLS);

    const prevScrollTop = pane.scrollTop;
    const wasAtBottom = ((pane.scrollHeight - pane.scrollTop - pane.clientHeight) < 24);

    const endIndex = buffer.baseY + buffer.cursorY;
    const { cmdStart, cmdCandidate, isCmdCandidate } = getCmdCandidateForPane(buffer, endIndex);
    const loopEnd = (isCmdCandidate ? (cmdStart - 1) : endIndex);

    // Performance: reading pane is only meant to show the recent screen/post context.
    const startIndex = Math.max(0, loopEnd - 700);

    // Coalesce xterm-wrapped physical lines into logical lines.
    const logical = [];
    for (let i = startIndex; i <= loopEnd; i++) {
        const lineObj = buffer.getLine(i);
        const lineText = stripANSI(lineObj?.translateToString(true) || '');
        const lineHtml = koicBufferLineToAnsiHtml(lineObj, paneCols);

        if (lineObj?.isWrapped && logical.length > 0) {
            // If the previous physical line ended with a real space in the last column,
            // preserve that word-boundary space when coalescing.
            // Without this, sequences like "that" + "mammals" can become "thatmammals".
            try {
                const prevLineObj = buffer.getLine(i - 1);
                if (koicLineHasSpaceAtCol(prevLineObj, paneCols - 1)) {
                    logical[logical.length - 1].text += ' ';
                    logical[logical.length - 1].html += ' ';
                }
            } catch (e) {}
            logical[logical.length - 1].text += lineText;
            logical[logical.length - 1].html += lineHtml;
        } else {
            logical.push({ text: lineText, html: lineHtml });
        }
    }

    for (const l of logical) {
        const t = String(l?.text || '').trimEnd();
        const h = String(l?.html || '');
        if (!t && !h) {
            htmlOut += '<div class="pane-ansi-line">&nbsp;</div>';
            continue;
        }

        if (t.match(headerRegex)) {
            htmlOut += '<div class="post-header">' + (h || koicEscapeHtml(t)) + '</div>';
        } else {
            htmlOut += '<div class="pane-ansi-line">' + (h || koicEscapeHtml(t)) + '</div>';
        }
    }

    // Render reconstructed command/prompt line, if detected.
    if (isCmdCandidate && cmdCandidate) {
        const base = (pane_inline_echo_base && (pane_inline_echo_base === cmdCandidate)) ? pane_inline_echo_base : cmdCandidate;
        const full = (pane_inline_echo_base && (pane_inline_echo_base === cmdCandidate))
            ? joinPromptAndValue(base, pane_inline_echo_value)
            : base;
        htmlOut += '<div class="cmd-line" onclick="cmdLineClick(event)">' + escapeHTML(wrapToCols(full)) + '</div>';
    }

    pane.innerHTML = htmlOut;
    schedulePaneLinkify();
    if (wasAtBottom) pane.scrollTop = pane.scrollHeight;
    else pane.scrollTop = prevScrollTop;

    // Announce the cmd-line text to screen readers when it changes (polite).
    if (isCmdCandidate && cmdCandidate && cmdCandidate !== _ariaLastPaneCmd) {
        _ariaLastPaneCmd = cmdCandidate;
        ariaAnnounce(cmdCandidate);
    }
}

function updateReadingPane() {
    // If ANSI is off, preserve the existing paragraph reflow renderer.
    // If ANSI is on, render per-cell SGR attributes (colors/bold/underline).
    try {
        if (clientCfg?.ansi) return updateReadingPaneAnsi();
    } catch (e) {}
    return updateReadingPanePlain();
}
function healAndWrap(lines) {
    // Paragraph reflow with safe joins:
    // - Join xterm-wrapped continuations without a space ONLY when it looks like a split word.
    // - Otherwise, join BBS hard-wrapped lines with a space into a paragraph.
    // - Preserve blank lines and special lines as their own blocks.
    let blocks = [];
    let para = '';
    let prevWrapped = false;
    let prevEndedWithSpace = false;
    let prevNearWrap = false;

    function flushPara() {
        if (para) blocks.push(para);
        para = '';
        prevWrapped = false;
        prevEndedWithSpace = false;
        prevNearWrap = false;
    }

    function isSpecialLine(tr) {
        return (
            tr.endsWith(':')
            || tr.startsWith('>')
            || /^\[[^\]]+>/.test(tr)
            || /Abort|Continue|Save|Edit|Xpress/i.test(tr)
        );
    }

    lines.forEach(item => {
        const rawText = (typeof item === 'string') ? item : (item?.text || '');
        const wrapped = (typeof item === 'string') ? false : !!item?.wrapped;
        const endedWithSpace = (typeof item === 'string') ? false : !!item?.endsWithSpace;
        const startedWithSpace = (typeof item === 'string') ? false : !!item?.startsWithSpace;
        const nearWrap = (typeof item === 'string') ? false : !!item?.nearWrap;
        const tr = rawText.trim();

        if (tr === '') {
            flushPara();
            return;
        }

        if (isSpecialLine(tr)) {
            flushPara();
            blocks.push(tr);
            return;
        }

        if (!para) {
            para = tr;
        } else {
            // Decide whether to join with space or not.
            // No-space join is only for obvious split-word continuations.
            const prevLastCh = para.length ? para[para.length - 1] : '';
            const nextFirstCh = tr.length ? tr[0] : '';
            const prevHardWrappedAtCol = !!prevNearWrap;
            const looksLikeSplitWord = (
                (wrapped || prevWrapped || prevHardWrappedAtCol)
                && (!prevEndedWithSpace || prevHardWrappedAtCol)
                && !startedWithSpace
                && /[A-Za-z0-9]/.test(prevLastCh)
                && /[A-Za-z0-9]/.test(nextFirstCh)
            );
            para += (looksLikeSplitWord ? '' : ' ') + tr;
        }

        prevWrapped = wrapped;
        prevEndedWithSpace = endedWithSpace;
        prevNearWrap = nearWrap;
    });

    flushPara();

    return blocks.map(b => {
        const wrapped = wrapToCols(b);
        const html = escapeHTML(wrapped).replace(/\n/g, '<br>');
        return '<div class="pane-block" style="text-decoration:none !important; display:block;">' + html + '</div>';
    }).join('');
}

function toggleEditor() {
    if (is_editing) {
        hideEditor();
    } else {
        draft_edit_mode = false;
        document.getElementById('scratchpad').value = "";
        showEditor();
    }
}

function cancelEditor() {
    // Cancel from the local compose overlay.
    // IMPORTANT: if the BBS requested compose (DOC G_POST), it is waiting for a response.
    // Hiding the editor without notifying the server can leave the session "hung".
    try {
        const sp = document.getElementById('scratchpad');
        if (sp) sp.value = '';
    } catch (e) {}
    draft_edit_mode = false;
    hideEditor();

    try {
        if (socket_obj?.readyState === 1) {
            socket_obj.send('__DRAFT_CANCEL__');
        }
    } catch (e) {}
}

function showEditor() {
    is_editing = true;
    document.getElementById('editor-overlay').style.display = 'flex';
    setNextBarVisible(false);
    try { handleResize(); } catch (e) {}
    setTimeout(() => {
        const sp = document.getElementById('scratchpad');
        if (sp) sp.focus();
    }, 50);
}

function hideEditor() {
    is_editing = false;
    document.getElementById('editor-overlay').style.display = 'none';
    if (!isTouchLike()) focusTerminal();
    handleResize();
}

function writePostMenuPrompt() {
    // Traditional-ish (mobile readable): bold + colors.
    const y = "\x1b[1;33m";
    const w = "\x1b[1;37m";
    const g = "\x1b[1;32m";  // bold green — preserves brightness for subsequent BBS output
    term_obj.write(
        "\r\n" +
        w + "A" + y + "bort  " +
        w + "C" + y + "ontinue  " +
        w + "E" + y + "dit  " +
        w + "P" + y + "rint  " +
        w + "S" + y + "ave " + y + "-> " + g,
        () => {
            try { checkGate(); } catch (e) {}
            try {
                if (pane_active) {
                    updateReadingPane();
                    renderPaneInlineEcho();
                }
            } catch (e) {}
            try { scrollAllToBottom(true); } catch (e) {}
            try { updateDebugHud(); } catch (e) {}
        }
    );
    ariaAnnounce('Post menu: Abort, Continue, Edit, Print, Save.', true);
    focusInput();
}

function hideKeyboard() {
    const input = document.getElementById('phantom-input');
    try { if (input) input.blur(); } catch (e) {}
    try {
        const ta = document.querySelector('#terminal textarea');
        if (ta) ta.blur();
    } catch (e) {}
}

function sendSpace() {
    if (!socket_obj || socket_obj.readyState !== 1) return;
    socket_obj.send(' ');
    // Reading UX: allow paging without forcing the keyboard.
    if (isTouchLike()) hideKeyboard();
}

function sendToBBS() {
    const content = document.getElementById('scratchpad').value;
    if (!socket_obj || socket_obj.readyState !== 1) return;
    socket_obj.send("__DRAFT__:" + content);
    draft_edit_mode = false;
    hideEditor();
}

function focusInput() { 
    const input = document.getElementById('phantom-input');
    if (input && document.activeElement !== input) input.focus(); 
}

function focusTerminal() {
    // Always try xterm focus first (works for desktop + many mobile browsers).
    try { term_obj?.focus(); } catch (e) {}
    // Fallback: focus phantom input (helps some mobile browsers / responsive mode).
    focusInput();

    // Android Brave/Chrome: resize immediately so the prompt isn't hidden behind the keyboard.
    if (isTouchLike()) {
        scheduleKeyboardResize();
        // If we're in reading-pane mode, keep the bottom line visible while the
        // keyboard animates (Chromium sometimes shifts geometry without firing a clean resize).
        if (pane_active) {
            setTimeout(() => { try { scrollAllToBottom(true); } catch (e) {} }, 0);
            setTimeout(() => { try { scrollAllToBottom(true); } catch (e) {} }, 220);
            setTimeout(() => { try { scrollAllToBottom(true); } catch (e) {} }, 900);
        }
    }
}