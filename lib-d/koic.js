// koic.js - 2025-06-13
const KOIC_VERSION = window.KOIC_VERSION || '';

// ── TinyURL shortening ────────────────────────────────────────────────────────

async function shortenUrl(url) {
	try {
		const resp = await fetch('/shorten?url=' + encodeURIComponent(url));
		if (!resp.ok) return url;
		const short = (await resp.text()).trim();
		return (short && /^https?:\/\//i.test(short)) ? short : url;
	} catch (e) { return url; }
}

async function shortenUrlsInText(text) {
	const threshold = parseInt(localStorage.getItem('koic_shorten_threshold') || '80', 10);
	const enabled = localStorage.getItem('koic_shorten_urls');
	if (enabled !== 'true') return text;
	const urlRe = /(https?:\/\/[^\s<>"']+)/g;
	let match;
	const replacements = [];
	while ((match = urlRe.exec(text)) !== null) {
		if (match[1].length >= threshold) {
			replacements.push({ url: match[1], index: match.index, length: match[1].length });
		}
	}
	if (!replacements.length) return text;
	const shortened = await Promise.all(replacements.map(r => shortenUrl(r.url)));
	let result = text;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i];
		result = result.slice(0, r.index) + shortened[i] + result.slice(r.index + r.length);
	}
	return result;
}

let term_obj, socket_obj, fit_addon, weblinks_addon, is_editing = false;
let ws_ping_timer = null;
let in_compose = false;  // Track if currently in text composition mode
let post_menu = false;   // Local post-action menu mode (client-side)
let draft_edit_mode = false; // Scratchpad edits draft instead of __REPLACE__
let seen_ansi = false;
let last_sgr = "";
let last_cmd_char = "";
let last_cmd_time = 0;
let login_handled = false, lobby_handled = false;
let last_target_seen = "";
let is_user_typing = false;
let awaiting_recipient = false;
let recipient_buffer = "";
let recipient_default = "";
let recipient_prompt_armed = false;
let password_mode = false;
let password_char_count = 0;
let awaiting_name = false;
let name_input_buffer = "";
let awaiting_str = false;   // G_STR non-password field (doing, etc.) — echo real chars
let awaiting_name_cap = false; // true only for type-3 G_NAME (person lookup: jump/skip/xpress)
let expect_gname = false;
let expect_gname_submitted = false;
let awaiting_five = false;
let five_line_buffer = "";
let five_waiting_end = false;
let prompt_context = ""; // readcmd/main/option/lobby/other
let numeric_input = false;  // echoing digits after - or # at readcmd prompt
let numeric_buffer = "";
let five_safety_timer = null;
let blocked_log = [];
let blocked_cursor = -1;

const default_font = "Menlo, Monaco, 'Courier New', monospace";

function getStoredFont() {
	return localStorage.getItem('koic_font') || default_font;
}

function applyFont(fontFamily) {
	const ff = fontFamily || getStoredFont();
	document.documentElement.style.setProperty('--koic-font', ff);
	const sp = document.getElementById('scratchpad');
	if (sp) sp.style.fontFamily = ff;
	if (term_obj) {
		try {
			// xterm.js v5 supports setOption; direct assignment also works.
			if (typeof term_obj.setOption === 'function') {
				term_obj.setOption('fontFamily', ff);
			} else {
				term_obj.options.fontFamily = ff;
			}
		} catch (e) {
			// Non-fatal: keep going.
		}
		setTimeout(() => { if (fit_addon) fit_addon.fit(); }, 50);
	}
}

function setStatus(text, level) {
	const el = document.getElementById('status-msg');
	if (el) {
		el.textContent = text;
		el.classList.remove('status-ok', 'status-warn', 'status-bad');
		if (level) el.classList.add(level);
	}
}

// ── Screen-reader live region ─────────────────────────────────────────────────
// Strips ANSI/VT escape sequences and control characters, then pushes the
// resulting plain text into the aria-live region so VoiceOver / NVDA users
// can follow terminal output without needing to interact with the xterm canvas.

let _ariaDebounceTimer = null;
let _ariaPending = '';

function ariaAnnounce(raw) {
    if (!raw) return;
    // Strip all ANSI / VT100 escape sequences (CSI, OSC, etc.)
    let plain = raw
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')   // CSI sequences (SGR, cursor moves, etc.)
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC sequences
        .replace(/\x1b[^[\]]/g, '')               // other two-byte escapes
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')  // C0 controls (keep \t \n \r)
        .replace(/\r\n/g, ' ')
        .replace(/[\r\n]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    if (!plain) return;

    // Debounce rapid writes into a single announcement (~80 ms window) to avoid
    // flooding VoiceOver with dozens of tiny utterances per second.
    _ariaPending += ' ' + plain;
    clearTimeout(_ariaDebounceTimer);
    _ariaDebounceTimer = setTimeout(() => {
        const el = document.getElementById('aria-live-region');
        if (!el) return;
        // Swap content rather than append so VoiceOver re-reads on every change.
        el.textContent = _ariaPending.trim();
        _ariaPending = '';
    }, 80);
}

// ── Scratchpad screen-reader live region ──────────────────────────────────────
// Announces the last word typed (on word boundary) or the full textarea content
// when the editor opens, so blind users can follow what they are writing.

let _spAriaTimer = null;
let _spLastWordCount = 0;

function scratchpadAnnounce(text) {
    if (text === undefined || text === null) return;
    const el = document.getElementById('aria-live-region-editor');
    if (!el) return;
    // Announce the last word once a word boundary (space/newline) is crossed,
    // otherwise fall silent — the browser's own caret tracking handles mid-word.
    const words = text.trimEnd().split(/\s+/).filter(Boolean);
    const wc = words.length;
    if (wc !== _spLastWordCount) {
        _spLastWordCount = wc;
        const last = words[wc - 1] || '';
        clearTimeout(_spAriaTimer);
        _spAriaTimer = setTimeout(() => {
            el.textContent = last;
        }, 50);
    }
}

function scratchpadAnnounceAll(text) {
    // Called when the editor opens. Announces content (or empty state) plus
    // usage instructions via the live region — more reliable than aria-describedby
    // across VoiceOver versions and verbosity settings.
    const el = document.getElementById('aria-live-region-editor');
    if (!el) return;
    _spLastWordCount = (text || '').trim().split(/\s+/).filter(Boolean).length;
    const content = text ? 'Editor opened with existing post. ' + text : 'Editor opened. Empty.';
    el.textContent = content + ' Tab moves to Done button. Ctrl Enter submits. Escape cancels.';
}


function startSession() {
    document.getElementById('start-overlay').style.display = 'none';
    loadSettings();
    applyFont();
    setupTerminal();
    setStatus('CONNECTING...', 'status-warn');
    connect();

    // Queue username/enemy list and send on websocket open (reliable).
    pending_login = localStorage.getItem('koic_handle') || '';
    pending_enemies = localStorage.getItem('koic_enemies') || '';

    // Wire scratchpad input to the screen-reader live region.
    const sp = document.getElementById('scratchpad');
    if (sp) {
        sp.addEventListener('input', () => scratchpadAnnounce(sp.value));

        sp.addEventListener('keydown', (e) => {
            // Tab: move focus to DONE button instead of inserting a tab character.
            // BBS posts don't use tab indentation, and this gives keyboard/AT users
            // a reliable way to reach the submit button without the mouse.
            if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault();
                document.getElementById('editor-done-btn')?.focus();
            }
            // Shift+Tab: move focus to CANCEL button.
            if (e.key === 'Tab' && e.shiftKey) {
                e.preventDefault();
                const btns = document.querySelectorAll('#editor-panel .scale-btn');
                if (btns.length) btns[0].focus(); // CANCEL is first
            }
            // Ctrl+Enter: submit the post.
            if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault();
                sendToBBS();
            }
            // Escape: cancel the editor.
            if (e.key === 'Escape') {
                e.preventDefault();
                cancelEditor();
            }
        });
    }
}

function isEnemy(name) {
	if (!name) return false;
	const raw = localStorage.getItem('koic_enemies') || "";
	return raw.split(/[\n,]+/).map(s => s.trim().toLowerCase()).filter(s => s).includes(name.toLowerCase());
}

function setupTerminal() {
	// Preserve scrollback: don't dispose xterm on reconnect.
	if (term_obj) {
		setTimeout(() => { if (fit_addon) fit_addon.fit(); term_obj.focus(); }, 50);
		return;
	}
	term_obj = new Terminal({
		cursorBlink: true,
		fontSize: 16,
		fontFamily: getStoredFont(),
		fontWeight: 400,
		fontWeightBold: 800,
		drawBoldTextInBrightColors: false,
		theme: { background: '#000', foreground: '#00CC00' },
		convertEol: true,
	});
	fit_addon = new FitAddon.FitAddon();
	term_obj.loadAddon(fit_addon);
	// Clickable URLs (http/https) with minimal overhead; uses xterm's built-in link handling.
	try {
		const WebLinksCtor = (
			(typeof WebLinksAddon !== 'undefined' && typeof WebLinksAddon === 'function') ? WebLinksAddon :
			(typeof WebLinksAddon !== 'undefined' && WebLinksAddon && WebLinksAddon.WebLinksAddon) ? WebLinksAddon.WebLinksAddon :
			null
		);

		if (WebLinksCtor) {
			// IMPORTANT: do NOT include the 'g' flag; the addon will add it.
			const urlRegex = /((?:https?:\/\/|www\.)[^\s<>()"']+[^\s<>()"'.,;:!?]|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[^^\s<>()"']*[^\s<>()"'.,;:!?])?|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;
			const normalizeUrl = (uri) => {
				if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(uri)) return 'mailto:' + uri;
				if (/^https?:\/\//i.test(uri)) return uri;
				return 'https://' + uri;
			};
			weblinks_addon = new WebLinksCtor((event, uri) => {
				const u = normalizeUrl(uri);
				try { window.open(u, '_blank', 'noopener,noreferrer'); } catch (e) {}
			}, { urlRegex });
			term_obj.loadAddon(weblinks_addon);
			console.log('KOIC: WebLinks addon loaded');
		} else {
			console.warn('KOIC: WebLinks addon not found; URLs will not be clickable');
		}
	} catch (e) {
		// Non-fatal: terminal still works.
		console.warn('KOIC: WebLinks addon init failed', e);
	}
	term_obj.open(document.getElementById('terminal'));
	
	const handleTermData = (data) => {
		if (socket_obj?.readyState === 1 && !is_editing) {
			// xterm can batch multiple keystrokes into one onData call (e.g. "jIn" when
			// typing fast). Process character-by-character so state changes like arming
			// expect_gname on 'j' take effect immediately for the chars that follow.
			if (data.length > 1 && !in_compose && !awaiting_five) {
				for (const ch of data) handleTermData(ch);
				return;
			}
			// Jump/Skip/Xpress type-ahead: after these commands, server will issue G_NAME.
			// Arm expect_gname so fast typing gets locally echoed immediately.
			if (!in_compose && !awaiting_name && !awaiting_recipient && !awaiting_five && !post_menu && !password_mode) {
				const inCommandContext = (prompt_context === 'readcmd' || prompt_context === 'main' || prompt_context === 'option' || prompt_context === 'forum' || prompt_context === 'lobby');
				if (inCommandContext && (data === 'j' || data === 'J')) {
					// Send __JUMP__: Perl atomically arms awaiting_name AND forwards 'j'
					// to the BBS in one step — no race window for fast-typed chars.
					try { socket_obj.send('__JUMP__'); } catch (e) {}
					expect_gname = true;
					expect_gname_submitted = false;
					name_input_buffer = "";
					return;
				}
				// S (Skip To): same atomic approach.
				if (inCommandContext && (data === 'S')) {
					try { socket_obj.send('__SKIP_TO__'); } catch (e) {}
					expect_gname = true;
					expect_gname_submitted = false;
					name_input_buffer = "";
					return;
				}
				// x/X (Xpress) still uses __EXPECT_GNAME__ — it goes through recipient flow.
				if (inCommandContext && (data === 'x' || data === 'X')) {
					expect_gname = true;
					expect_gname_submitted = false;
					name_input_buffer = "";
					socket_obj.send(data);
					return;
				}
			}

			// F9: open KOIC message viewer locally (never send to BBS)
			// Keep Ctrl-X free for the BBS's own review feature.
			if (data === '\x1b[20~' && !in_compose && !awaiting_name && !awaiting_recipient && !awaiting_five && !post_menu && !password_mode) {
				openBlockedViewer();
				return;
			}

			// G_FIVE local 5-line entry mode (Xpress/profile info)
			if (awaiting_five) {
				// After sending the terminating blank line, block further input until backend confirms.
				if (five_waiting_end) {
					return;
				}

				// Echo + local editing; backend will send __FIVE_PROMPT__/__FIVE_END__.
				if (data === '\r' || data === '\n') {
					const isTerminator = (five_line_buffer.length === 0);
					socket_obj.send('\r');
					term_obj.write('\r\n');
					five_line_buffer = "";
					if (isTerminator) {
						five_waiting_end = true;
					}
					return;
				}
				if (data === '\x08' || data === '\x7f') {
					if (five_line_buffer.length > 0) {
						five_line_buffer = five_line_buffer.slice(0, -1);
					}
					term_obj.write('\x08 \x08');
					socket_obj.send(data);
					return;
				}
				if (data && data.length === 1 && data.charCodeAt(0) >= 32) {
					if (five_line_buffer.length >= 78) {
						term_obj.write('\x07');
						return;
					}
					five_line_buffer += data;
					term_obj.write(data);
					socket_obj.send(data);
				}
				return;
			}

			// Local post-action menu: keystrokes go to backend only (no BBS echo)
			if (post_menu) {
				socket_obj.send(data);
				return;
			}


			// Numeric input echo for '-' (read last N) and '#' (read by number) at readcmd prompt.
			if (!in_compose && !awaiting_name && !awaiting_recipient && !password_mode) {
				if (!numeric_input && (data === '-' || data === '#') && prompt_context === 'readcmd') {
					numeric_input = true;
					numeric_buffer = "";
					socket_obj.send(data);
					return;
				}
			}
			if (numeric_input) {
				if (data === '\r' || data === '\n') {
					socket_obj.send('\r');
					term_obj.write('\r\n');
					numeric_input = false;
					numeric_buffer = "";
					return;
				}
				if (data === '\x08' || data === '\x7f') {
					if (numeric_buffer.length > 0) {
						numeric_buffer = numeric_buffer.slice(0, -1);
						term_obj.write('\x08 \x08');
					}
					socket_obj.send(data);
					return;
				}
				if (/[0-9]/.test(data)) {
					numeric_buffer += data;
					term_obj.write(data);
					socket_obj.send(data);
					return;
				}
				// Non-numeric, non-enter: cancel numeric mode and fall through
				numeric_input = false;
				numeric_buffer = "";
			}
			// G_STR non-password mode: echo real characters, no capitalization forced.
			if (awaiting_str) {
				if (data === '\r' || data === '\n') {
					awaiting_str = false;
					term_obj.write('\r\n');
				} else if (data === '\x08' || data === '\x7f') {
					term_obj.write('\x08 \x08');
				} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
					term_obj.write(data);
				}
				socket_obj.send(data);
				return;
			}

			// Handle password mode echo
			if (password_mode) {
				if (data === '\r') {
					// Enter pressed - clear password mode
					password_mode = false;
					password_char_count = 0;
				} else if (data === '\x08' || data === '\x7f') {
					// Backspace - remove last dot
					if (password_char_count > 0) {
						password_char_count--;
						term_obj.write('\x08 \x08');  // Backspace, space, backspace
					}
				} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
					// Regular character - echo a dot
					password_char_count++;
					term_obj.write('.');
				}
				socket_obj.send(data);
				return;
			}

			// Jump type-ahead (pre-G_NAME): buffer chars until __AWAITING_NAME__ arrives.
			if (expect_gname && !awaiting_name && !in_compose && !awaiting_recipient && !awaiting_five && !post_menu && !password_mode) {
				if (data === '\r' || data === '\n') {
					// Hold — flush on __AWAITING_NAME__.
					expect_gname_submitted = true;
					return;
				}
				if (data === '\x08' || data === '\x7f') {
					if (name_input_buffer.length > 0) {
						name_input_buffer = name_input_buffer.slice(0, -1);
						term_obj.write('\x08 \x08');
					}
					// Don't send backspace to Perl — buffer is local until __AWAITING_NAME__.
					return;
				}
				if (data && data.length === 1 && data.charCodeAt(0) >= 32) {
					const ch = capNameChar(data, name_input_buffer);
					// Hold chars in name_input_buffer — don't send to Perl yet and
					// don't echo locally. Both race: chars sent to Perl race against
					// pre_name_mode being armed; local echo appears before the BBS
					// prints the Jump prompt. Flush everything on __AWAITING_NAME__.
					name_input_buffer += ch;
					return;
				}
				// For other control sequences, just pass through.
			}
			
			if (data === 'e' && isAtSavePrompt()) { grabAndEdit(); return; }

			// Handle backspace at name input prompts (forum jump, etc.)
			if (awaiting_name && (data === '\x08' || data === '\x7f')) {
				if (name_input_buffer && name_input_buffer.length > 0) {
					name_input_buffer = name_input_buffer.slice(0, -1);
					term_obj.write('\x08 \x08');
				}
				// Don't send backspace to Perl — buffer is local, sent as a block on Enter.
				return;
			}

			// Handle Return in name input mode: send entire buffer as one block + \r
			if (awaiting_name && (data === '\r' || data === '\n')) {
				socket_obj.send(name_input_buffer + '\r');
				term_obj.write('\r\n');
				awaiting_name = false;
				name_input_buffer = '';
				recipient_default = '';
				return;
			}
			
			// Check recipient input for enemy blocking
			if (awaiting_recipient) {
				// Normalize DEL to BS for consistent local editing + BBS behavior
				const bs = (data === '\x7f') ? '\x08' : data;
				if (data === '\r' || data === '\n') {
					// User pressed Enter - check if recipient is a bozo
					if (isEnemy(recipient_buffer.trim())) {
						alert("KOIC: Cannot send to Bozo (" + recipient_buffer.trim() + "). Aborting.");
						socket_obj.send("\x03\r");  // Send Ctrl-C
						setTimeout(() => {
							socket_obj.send("ABORT\r\r");  // Fully abort the message
						}, 200);
						awaiting_recipient = false;
						recipient_buffer = "";
						return;
					}
					// Submit recipient and show the newline immediately (BBS often doesn't echo)
					socket_obj.send("\r\n");
					term_obj.write("\r\n");
					awaiting_recipient = false;
					recipient_buffer = "";
					return;
				} else if (data === '\x03' || data === '\x08' || data === '\x7f') {
					// Backspace/DEL or Ctrl-C
					if ((data === '\x08' || data === '\x7f') && recipient_buffer.length > 0) {
						recipient_buffer = recipient_buffer.slice(0, -1);
						term_obj.write('\x08 \x08');
					} else if (data === '\x03') {
						awaiting_recipient = false;
						recipient_buffer = "";
					}
					socket_obj.send(bs);
					return;
				} else {
					const ch = capNameChar(data, recipient_buffer);
					recipient_buffer += ch;
					term_obj.write(ch);
				}
			}
			
			// Track single-key commands so we can suppress the common echo pattern (eEnter message)
			// Only track lowercase — uppercase commands like 'S' (Skip To) don't get echoed the same way.
			if (!in_compose && !awaiting_name && !awaiting_recipient && !password_mode && data && data.length === 1 && data !== '\r' && data !== '\n' && data >= 'a' && data <= 'z') {
				last_cmd_char = data;
				last_cmd_time = Date.now();
			}

			// In awaiting_name mode, echo chars immediately and buffer them.
			// The whole buffer is sent as one block on Enter. No double-echo risk since
			// the BBS does not echo ISCA_BLOCK submissions.
			if (awaiting_name && data.length === 1 && data.charCodeAt(0) >= 32) {
				const ch = awaiting_name_cap ? capNameChar(data, name_input_buffer) : data;
				term_obj.write(ch);
				name_input_buffer += ch;
				return;
			}

			// Clear prompt context on Enter so intercepts (Skip-To, etc.) don't fire
			// against a stale state while waiting for the next BBS prompt to arrive.
			if (data === '\r') prompt_context = '';
			socket_obj.send(data);

			// Only echo printable characters in specific input modes
			if (password_mode && data !== '\r' && data.charCodeAt(0) >= 32) {
				// Password mode: echo dots
				term_obj.write(data);
			} else if (in_compose) {
				// Text composition mode: echo all input characters
				if (data === '\r') {
					term_obj.write('\r\n');
				} else if (data === '\x04') {
					// Ctrl+D: end of composition (send with echo as feedback)
					socket_obj.send(data);  // Send Ctrl+D to backend
					term_obj.write('\r\n');
					return;  // Don't send again below
				} else if (data !== '\x08' && data !== '\x7f' && data.charCodeAt(0) >= 32) {
					term_obj.write(data);
				} else if (data === '\x08' || data === '\x7f') {
					// Backspace handling
					term_obj.write('\x08 \x08');
				}
			}
			// If NOT in any special mode, don't echo (let BBS handle echo of command keys)
		}
	};
	term_obj.onData(handleTermData);
	
	setTimeout(() => { fit_addon.fit(); term_obj.focus(); }, 100);

	// Refit terminal on window resize (debounced to avoid thrashing during drag).
	let _koic_resize_timer = null;
	window.addEventListener('resize', () => {
		clearTimeout(_koic_resize_timer);
		_koic_resize_timer = setTimeout(() => {
			if (fit_addon) fit_addon.fit();
		}, 100);
	});
}

function reconnect() {
	in_compose = false;
	post_menu = false;
	awaiting_name = false;
	awaiting_name_cap = false;
	awaiting_recipient = false;
	awaiting_five = false;
	awaiting_str = false;
	password_mode = false;
	expect_gname = false;
	login_handled = false;
	lobby_handled = false;
	name_input_buffer = "";
	recipient_buffer = "";
	five_line_buffer = "";
	last_cmd_char = "";
	setStatus('RECONNECTING...', 'status-warn');
	if (socket_obj) {
		try { socket_obj.close(); } catch (e) {}
		socket_obj = null;
	}
	pending_login = localStorage.getItem('koic_handle') || '';
	pending_enemies = localStorage.getItem('koic_enemies') || '';
	connect();
}

function connect() {
	if (socket_obj && (socket_obj.readyState === 0 || socket_obj.readyState === 1)) return;
	socket_obj = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/bbs');
	socket_obj.onopen = () => {
		setStatus('CONNECTED', 'status-ok');
		// Start WebSocket keepalive ping — fires every 2.5 min to prevent
		// reverse-proxy idle-timeout from killing the connection.
		clearInterval(ws_ping_timer);
		ws_ping_timer = setInterval(() => {
			if (socket_obj && socket_obj.readyState === 1) {
				try { socket_obj.send('__PING__'); } catch (e) {}
			}
		}, 150000);
		try {
			const username = (pending_login ?? (localStorage.getItem('koic_handle') || ''));
			const enemies = (pending_enemies ?? (localStorage.getItem('koic_enemies') || ''));
			const directEditor = localStorage.getItem('koic_direct_editor') === 'true' ? '1' : '0';
			socket_obj.send("__LOGIN__:" + username);
			socket_obj.send("__ENEMIES__:" + enemies);
			socket_obj.send("__PREF_DIRECT_EDITOR__:" + directEditor);
		} catch (e) {
			console.error('KOIC: onopen send failed', e);
		}
	};
	socket_obj.onclose = () => {
		clearInterval(ws_ping_timer);
		ws_ping_timer = null;
		post_menu = false;
		in_compose = false;
		term_obj.write("\r\n\r\n[KOIC disconnected.]\r\n");
		setStatus('DISCONNECTED', 'status-bad');
	};
	socket_obj.onerror = () => {
		setStatus('DISCONNECTED', 'status-bad');
	};
	socket_obj.onmessage = async (e) => {
		const buffer = await e.data.arrayBuffer();
		let text = new TextDecoder().decode(buffer);

		if (text.includes('__AWAITING_NAME__')) {
		}

		if (text.includes("\x1b[")) {
			seen_ansi = true;
		}

		// Capture most recent SGR so local prompts can match BBS palette.
		const sgrMatches = text.match(/\x1b\[[0-9;]*m/g);
		if (sgrMatches && sgrMatches.length) {
			last_sgr = sgrMatches[sgrMatches.length - 1];
		}
		
		// Silently absorb server-initiated keepalive ping (sent every 45s from Perl
		// to keep the WebSocket alive regardless of browser tab throttling).
		if (text === '__SERVER_PING__') { return; }

		// Check for special backend signals
		if (text === "__CLIENT_CONFIG__" || text.startsWith("__CLIENT_CONFIG__:")) {
			loadSettings();
			toggleOverlay('settings-modal');
			return;
		}
		if (text === "__COMPOSE_START__") {
			// Open the scratchpad for all users — it's the universal default now.
			// The Perl side doesn't care how the editor was opened; it just waits
			// for __DRAFT__: the same as the direct_editor path.
			document.getElementById('scratchpad').value = '';
			draft_edit_mode = false;
			showEditorPanel();
			return;
		}
		if (text.startsWith("__AWAITING_NAME__")) {
			const _nameType = parseInt(text.split(":")[1] || "0");
			awaiting_name_cap = (_nameType === 3); // capitalize only for person-name lookup
			awaiting_name = true;
			const was_submitted = expect_gname_submitted;
			expect_gname = false;
			expect_gname_submitted = false;
			awaiting_five = false;
			awaiting_recipient = false;
			recipient_prompt_armed = false;
			// Flush buffered type-ahead to Perl now that awaiting_name is active.
			// Only submit if the user already pressed Enter; otherwise keep the buffer
			// and let the Enter handler send it when they finish typing.
			if (was_submitted) {
				socket_obj.send(name_input_buffer + '\r');
				awaiting_name = false;
				name_input_buffer = '';
			}
			return;
		}
		if (text === "__AWAITING_STR__") {
			// G_STR for a non-password field (e.g. doing, plan). If password_mode is
			// already active (set by "Password:" text detection), leave it alone —
			// dot echo is already correct for that field.
			if (!password_mode) {
				awaiting_str = true;
			}
			return;
		}
		if (text.startsWith("__FIVE_START__:")) {
			awaiting_five = true;
			awaiting_name = false;
			awaiting_recipient = false;
			recipient_buffer = "";
			name_input_buffer = "";
			five_line_buffer = "";
			five_waiting_end = false;
			term_obj.write(">");
			// Safety timeout: if __FIVE_END__ never arrives (e.g. BBS auto-completes
			// a received Xpress G_FIVE without waiting for user input), clear the flag
			// so the client doesn't get stuck eating keystrokes.
			clearTimeout(five_safety_timer);
			five_safety_timer = setTimeout(() => {
				if (awaiting_five) {
					awaiting_five = false;
					five_waiting_end = false;
					five_line_buffer = "";
				}
			}, 1000);
			return;
		}
		if (text === "__FIVE_PROMPT__") {
			if (awaiting_five) term_obj.write('>');
			clearTimeout(five_safety_timer); // Still active, reset the timer
			five_safety_timer = setTimeout(() => {
				if (awaiting_five) {
					awaiting_five = false;
					five_waiting_end = false;
					five_line_buffer = "";
				}
			}, 1000);
			return;
		}
		if (text === "__FIVE_END__") {
			clearTimeout(five_safety_timer);
			awaiting_five = false;
			five_line_buffer = "";
			five_waiting_end = false;
			return;
		}
		if (text === "__MORE_PROMPT__") {
			// DOC protocol --MORE-- prompt detected, auto-send space to advance
			setTimeout(() => {
				if (socket_obj && socket_obj.readyState === 1) {
					socket_obj.send(" ");
				}
			}, 100);
			return;
		}
		if (text === "__COMPOSE_END__") {
			// Composition mode ended on backend, update frontend state
			in_compose = false;
			return;
		}
		if (text === "__POST_MENU__") {
			post_menu = true;
			// Safety: ensure we never locally echo menu hotkeys.
			in_compose = false;
			return;
		}
		if (text === "__POST_MENU_END__") {
			post_menu = false;
			// Safety: leaving menu should never leave us stuck in compose mode.
			in_compose = false;
			return;
		}
		if (text === "__POST_MENU_PROMPT__") {
			writePostMenuPrompt();
			return;
		}
		if (text.startsWith("__EDIT_DRAFT__:")) {
			const b64 = text.slice("__EDIT_DRAFT__:".length);
			try {
				const binStr = atob(b64);
				const bytes = new Uint8Array(binStr.length);
				for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
				const draft = new TextDecoder().decode(bytes);
				document.getElementById('scratchpad').value = draft;
				draft_edit_mode = true;
				toggleOverlay('editor-panel');
			} catch (err) {
				console.error("Failed to decode draft", err);
			}
			return;
		}
		if (text.startsWith("__DRAFT_RENDER__:")) {
			const b64 = text.slice("__DRAFT_RENDER__:".length);
			try {
				const binStr = atob(b64);
				const bytes = new Uint8Array(binStr.length);
				for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
				const draft = new TextDecoder().decode(bytes);
				// Show edited draft immediately before the menu prompt
				term_obj.write("\r\n" + draft.replace(/\n/g, "\r\n") + "\r\n");
				writePostMenuPrompt();
			} catch (err) {
				console.error("Failed to render draft", err);
			}
			return;
		}

		if (text.startsWith("__BLOCKED_CAPTURE__:") || text.startsWith("__CAPTURE__:")) {
			// __BLOCKED_CAPTURE__:<kind>:<direction>:<who>:<base64>
			// __CAPTURE__:<kind>:<direction>:<who>:<base64>
			try {
				const isBlocked = text.startsWith("__BLOCKED_CAPTURE__:");
				const rest = text.slice((isBlocked ? "__BLOCKED_CAPTURE__:" : "__CAPTURE__:").length);
				const parts = rest.split(":");
				const kind = parts[0] || 'unknown';
				const direction = parts[1] || 'incoming';
				const who = parts[2] || '';
				const b64 = parts.slice(3).join(":") || '';
				const binStr = atob(b64);
				const bytes = new Uint8Array(binStr.length);
				for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
				const captured = new TextDecoder().decode(bytes);
				blocked_log.push({
					when: new Date().toISOString(),
					enemy: who,
					kind,
					direction,
					blocked: isBlocked,
					captured,
				});
				blocked_cursor = blocked_log.length - 1;
			} catch (err) {
				// non-fatal
			}
			return;
		}
		
		let cleanRaw = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

		if (/Thanks for dropping by\./i.test(cleanRaw)) {
			setStatus('LOGGED OUT', 'status-warn');
		}

		const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

		// Suppress the common single-character command echo that gets glued to the next server output.
		// Examples:
		// - "Babble> eEnter message" -> remove stray 'e'
		// - "Video Games> nRead New" -> remove stray 'n'
		// - "Read cmd -> sStop" -> remove stray 's'
		if (last_cmd_char && (Date.now() - last_cmd_time) < 3000) {
			const cmd = escapeRegExp(last_cmd_char);

			// Case 1: output begins with the echoed command
			const leadingTrimmed = cleanRaw.replace(/^[\r\n]+/, '');
			if (leadingTrimmed.startsWith(last_cmd_char) && leadingTrimmed.length > 1 && !/\s/.test(leadingTrimmed[1])) {
				// Remove the first occurrence after leading CR/LF and any SGR
				const rx = new RegExp(`^([\\r\\n]*)(?:\\x1b\\[[0-9;]*m)*${cmd}(?=[A-Za-z])`);
				text = text.replace(rx, '$1');
				cleanRaw = cleanRaw.replace(new RegExp(`^([\\r\\n]*)${cmd}(?=[A-Za-z])`), '$1');
				last_cmd_char = "";
			} else {
				// Allow ANSI SGR between separator and echoed key.
				const rxPromptGlue = new RegExp(`(>\\s+)(?:\\x1b\\[[0-9;]*m)*${cmd}(?=[A-Za-z])`, 'g');
				const rxArrowGlue  = new RegExp(`(->\\s+)(?:\\x1b\\[[0-9;]*m)*${cmd}(?=[A-Za-z])`, 'g');
				const newClean = cleanRaw.replace(rxPromptGlue, '$1').replace(rxArrowGlue, '$1');
				if (newClean !== cleanRaw) {
					cleanRaw = newClean;
					text = text.replace(rxPromptGlue, '$1').replace(rxArrowGlue, '$1');
					last_cmd_char = "";
				}
			}
		}
		
		// Compose echo: if the BBS prints an "Enter message" prompt without a backend signal,
		// enable local echo. We aggressively clear this on any main prompt to avoid getting stuck.
		if (!post_menu && cleanRaw.includes("Enter message")) {
			in_compose = true;
		}
		
		// DETECT PROMPT STATE
		const isMainPrompt = /(Read cmd|Lobby>|Main>|Option:|Next:|Continue\?)/i.test(cleanRaw);
		// Forum-level prompts end frames with "ForumName> " (word(s) + "> " at end of output).
		// These are where Jump is available; they need the same state cleanup as main prompts.
		const isForumPrompt = /[A-Za-z]> $/.test(cleanRaw);
		const isEditorPrompt = cleanRaw.includes("> ");
		const isRecipientPrompt = /Recipient:|Enter recipient:/i.test(cleanRaw);

		if (isMainPrompt) {
			in_compose = false;
		}

		// isForumPrompt is end-anchored ($), so test it first -- it's the most reliable
		// indicator of the current prompt and won't false-match historical output above.
		// For the rest, check only the tail of cleanRaw so stale 'Read cmd' or 'Main>'
		// text earlier in the same chunk doesn't clobber the current context.
		const promptTail = cleanRaw.slice(-120);
		if (isForumPrompt) prompt_context = 'forum';
		else if (/\bLobby>/i.test(promptTail)) prompt_context = 'lobby';
		else if (/\bRead cmd\b/i.test(promptTail)) prompt_context = 'readcmd';
		else if (/\bMain>/i.test(promptTail)) prompt_context = 'main';
		else if (/\bOption:/i.test(promptTail)) prompt_context = 'option';
		else if (isMainPrompt) prompt_context = 'other';

		if (isMainPrompt || isForumPrompt) {
			is_user_typing = false;
			last_target_seen = "";
			awaiting_recipient = false;
			recipient_buffer = "";
			numeric_input = false;
			numeric_buffer = "";
			// Clear Xpress/Jump type-ahead state. If the BBS returns to a prompt without
			// sending __AWAITING_NAME__ (e.g. failed Xpress, or successful forum jump),
			// expect_gname/awaiting_name stay armed and silently swallow keystrokes.
			// Safe to reset here — a real G_NAME will re-arm via __AWAITING_NAME__.
			expect_gname = false;
			expect_gname_submitted = false;
			awaiting_name = false;
			awaiting_name_cap = false;
			name_input_buffer = "";
			recipient_prompt_armed = false;
			awaiting_str = false;
		}
		if (isRecipientPrompt && !recipient_prompt_armed && !awaiting_name && !awaiting_five && !post_menu && !in_compose) {
			recipient_prompt_armed = true;
			try { socket_obj.send("__RECIP_PROMPT__"); } catch (e) {}
		}
		if (isRecipientPrompt && !awaiting_name && !awaiting_five && !post_menu && !in_compose) {
			awaiting_recipient = true;
			recipient_buffer = "";
		}
		if (isEditorPrompt || isRecipientPrompt) { is_user_typing = true; }

		// Capture default recipient for outbound Xpress (e.g., "Recipient (Feoh):") so backend can block
		// even when user hits Enter on an empty recipient (accepting default).
		const recipDefMatch = cleanRaw.match(/Recipient\s*\(([^)]+)\):/i);
		if (recipDefMatch && recipDefMatch[1]) {
			const d = recipDefMatch[1].trim();
			if (d && d !== recipient_default) {
				recipient_default = d;
				try { socket_obj.send("__RECIP_DEFAULT__:" + d); } catch (e) {}
			}
		}

		// Enemy blocking is handled server-side (protocol-aware) and captured via __BLOCKED_CAPTURE__.

		if (isMainPrompt || isRecipientPrompt || isEditorPrompt) { 
			term_obj.write("\x1b[0m\x1b[1;32m" + text); 
			term_obj.focus();
			// Clear password mode once we're at a main prompt (indicates successful login)
			if (password_mode) password_mode = false;
			ariaAnnounce(text);
		} else if (text.includes("Password:")) {
			term_obj.write("\r\n" + text);
			password_mode = true;
			awaiting_str = false;  // override G_STR echo -- password field takes priority
			password_char_count = 0;
			setTimeout(() => { term_obj.focus(); }, 100);
			// Announce the password prompt but not the characters typed (security).
			ariaAnnounce("Password:");
		} else {
			term_obj.write(text);
			ariaAnnounce(text);
		}
		
		if (!login_handled && /Name:\s*$/i.test(cleanRaw.trim())) handleAutoLogin();
		if (localStorage.getItem('koic_use_ansi') === 'true' && !lobby_handled && /\bLobby>/.test(cleanRaw)) {
			lobby_handled = true;
			setTimeout(() => { socket_obj.send("cty "); }, 500);
		}
	};
}

window.sendCommand = (c, shouldFocus) => {
	if (socket_obj?.readyState === 1) {
		socket_obj.send(c);
		if (shouldFocus) term_obj.focus();
	}
};

// Capitalize first character of each word; preserve existing caps (handles DrMemory, Van Halen etc.)
function capName(s) {
	if (!s) return s;
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function capNameChar(ch, buffer) {
	// Capitalize if it's the first char, or if the previous char was a space.
	if (buffer.length === 0 || buffer[buffer.length - 1] === ' ') {
		return ch.toUpperCase();
	}
	return ch;
}

function handleAutoLogin() {
	const raw = localStorage.getItem('koic_handle') || '';
	const h = raw.replace(/(?:^|\s)\S/g, c => c.toUpperCase());
	if (h) { 
		login_handled = true; 
		// Delay local echo slightly to avoid racing the final "Name:" draw.
		setTimeout(() => {
			term_obj.write(h);
			if (term_obj._core && term_obj._core._inputBuffer !== undefined) {
				term_obj._core._inputBuffer = '';
			}
		}, 50);
		setTimeout(() => { socket_obj.send(h + "\r"); }, 250);
	}
}

function loadSettings() {
	document.getElementById('setting-handle').value = localStorage.getItem('koic_handle') || "";
	document.getElementById('setting-ansi').checked = localStorage.getItem('koic_use_ansi') === 'true';
	document.getElementById('setting-enemies').value = localStorage.getItem('koic_enemies') || "";
	const storedFont = localStorage.getItem('koic_font') || default_font;
	const fontSel = document.getElementById('setting-font');
	if (fontSel) fontSel.value = storedFont;
	const shortenChk = document.getElementById('setting-shorten');
	if (shortenChk) shortenChk.checked = localStorage.getItem('koic_shorten_urls') === 'true';
	const threshEl = document.getElementById('setting-shorten-threshold');
	if (threshEl) threshEl.value = localStorage.getItem('koic_shorten_threshold') || '80';
	const directEditorChk = document.getElementById('setting-direct-editor');
	if (directEditorChk) directEditorChk.checked = localStorage.getItem('koic_direct_editor') === 'true';
}

function saveSettings() {
	localStorage.setItem('koic_handle', document.getElementById('setting-handle').value);
	localStorage.setItem('koic_use_ansi', document.getElementById('setting-ansi').checked);
	localStorage.setItem('koic_enemies', document.getElementById('setting-enemies').value);
	const fontSel = document.getElementById('setting-font');
	if (fontSel) {
		localStorage.setItem('koic_font', fontSel.value || default_font);
		applyFont(fontSel.value || default_font);
	}
	const shortenChk = document.getElementById('setting-shorten');
	if (shortenChk) localStorage.setItem('koic_shorten_urls', shortenChk.checked);
	const threshEl = document.getElementById('setting-shorten-threshold');
	if (threshEl) localStorage.setItem('koic_shorten_threshold', threshEl.value || '80');
	const directEditorChk = document.getElementById('setting-direct-editor');
	if (directEditorChk) localStorage.setItem('koic_direct_editor', directEditorChk.checked);

	// Push updated prefs to server immediately (no reconnect needed).
	try {
		if (socket_obj && socket_obj.readyState === 1) {
			const enemies = document.getElementById('setting-enemies').value;
			socket_obj.send("__ENEMIES__:" + enemies);
			const directEditor = directEditorChk && directEditorChk.checked ? '1' : '0';
			socket_obj.send("__PREF_DIRECT_EDITOR__:" + directEditor);
		}
	} catch (e) {}

	toggleOverlay('settings-modal');
}

function openBlockedViewer() {
	const el = document.getElementById('blocked-viewer');
	if (!el) return;
	if (!blocked_log.length) {
		el.value = "(No captured Xpress messages yet.)\n\nTip: Open this viewer with F9. Ctrl-X is reserved for the BBS review feature.";
		blocked_cursor = -1;
	} else {
		if (blocked_cursor < 0 || blocked_cursor >= blocked_log.length) blocked_cursor = blocked_log.length - 1;
		const cur = blocked_log[blocked_cursor];
		const tag = cur.blocked ? 'BLOCKED' : 'OK';
		const header = `[${cur.kind.toUpperCase()} ${cur.direction.toUpperCase()} ${tag}] ${cur.enemy} @ ${cur.when}`;
		el.value = header + "\n\n" + (cur.captured || '').replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	}
	toggleOverlay('blocked-modal');
	setTimeout(() => { el.scrollTop = 0; }, 10);
}

window.blockedPrev = () => {
	if (!blocked_log.length) return;
	blocked_cursor = Math.max(0, blocked_cursor - 1);
	openBlockedViewer();
};

window.blockedNext = () => {
	if (!blocked_log.length) return;
	blocked_cursor = Math.min(blocked_log.length - 1, blocked_cursor + 1);
	openBlockedViewer();
};

window.copyBlocked = async () => {
	const el = document.getElementById('blocked-viewer');
	if (!el) return;
	try {
		await navigator.clipboard.writeText(el.value || '');
	} catch (e) {
		// Fallback: select for manual copy
		el.focus();
		el.select();
	}
};

function isAtSavePrompt() {
	const b = term_obj.buffer.active;
	const line = b.getLine(b.baseY + b.cursorY)?.translateToString() || "";
	const t = line.trim();
	// Only trigger overlay editor at explicit save/edit/abort prompts, NOT at "Read cmd ->"
	return /^[<\[]A[>\]]bort/i.test(t) || /^Save, Edit, Abort/i.test(t) || /^Continue, Edit, press/i.test(t);
}

function grabAndEdit() {
	const b = term_obj.buffer.active;
	const total = b.baseY + b.cursorY;
	const hRegex = /^[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}.*from/i;
	let start = -1;
	for (let i = total - 1; i >= Math.max(0, total - 60); i--) {
		if (hRegex.test(b.getLine(i).translateToString().trim())) { start = i + 1; break; }
	}
	if (start === -1) return;
	let post = [];
	for (let i = start; i < total; i++) {
		let lt = b.getLine(i).translateToString().trimEnd();
		if (/[<\[]A[>\]]bort|Continue|Edit|Save/.test(lt)) break;
		post.push(lt);
	}
	document.getElementById('scratchpad').value = post.join('\n').trim();
	toggleOverlay('editor-panel');
}

function writePostMenuPrompt() {
	// Traditional-client style:
	// - Entire prompt in bold
	// - No brackets/angles
	// - Hotkey letter (uppercase) in white
	// - Remainder of each word in yellow
	// - After the arrow, return to green input (non-bold)
	const y = "\x1b[1;33m";      // bold yellow
	const w = "\x1b[1;37m";      // bold white
	const input = "\x1b[0;32m";  // normal green
	term_obj.write(
		"\r\n" +
		w + "A" + y + "bort  " +
		w + "C" + y + "ontinue  " +
		w + "E" + y + "dit  " +
		w + "P" + y + "rint  " +
		w + "S" + y + "ave " + y + "-> " + input
	);
	term_obj.focus();
}

function showEditorPanel() {
    is_editing = true;
    document.getElementById('editor-panel').classList.add('active');
    document.getElementById('editor-drag-handle').classList.add('active');
    // Hide the terminal from AT while the editor dialog is open.
    // aria-modal alone is unreliable on older VoiceOver/iOS Safari; explicitly
    // marking the background inert to AT is the belt-and-suspenders fix.
    const tg = document.getElementById('terminal-gutter');
    if (tg) tg.setAttribute('aria-hidden', 'true');
    fit_addon.fit();
    setTimeout(() => {
        const sp = document.getElementById('scratchpad');
        sp.focus();
        scratchpadAnnounceAll(sp.value);
    }, 50);
}

function hideEditorPanel() {
	is_editing = false;
	const panel = document.getElementById('editor-panel');
	panel.classList.remove('active');
	panel.style.height = ''; // reset to CSS default
	document.getElementById('editor-drag-handle').classList.remove('active');
	// Restore terminal to AT now that the editor is closed.
	const tg = document.getElementById('terminal-gutter');
	if (tg) tg.removeAttribute('aria-hidden');
	fit_addon.fit();
	term_obj.focus();
}

function cancelEditor() {
	try { document.getElementById('scratchpad').value = ''; } catch(e) {}
	draft_edit_mode = false;
	hideEditorPanel();
	try {
		if (socket_obj?.readyState === 1) socket_obj.send('__DRAFT_CANCEL__');
	} catch(e) {}
}

function toggleOverlay(id) {
	if (id === 'editor-overlay' || id === 'editor-panel') {
		if (is_editing) hideEditorPanel(); else showEditorPanel();
		return;
	}
	const el = document.getElementById(id);
	const opening = (el.style.display === 'none' || el.style.display === '');
	el.style.display = opening ? 'flex' : 'none';
	if (opening) {
		const inp = el.querySelector('input') || el.querySelector('textarea');
		if (inp) inp.focus();
	} else {
		term_obj.focus();
		fit_addon.fit();
	}
}

// Drag-to-resize for editor panel
(function() {
	let dragging = false;
	let startY = 0;
	let startHeight = 0;

	document.addEventListener('mousedown', e => {
		const handle = document.getElementById('editor-drag-handle');
		if (!handle || !handle.contains(e.target)) return;
		const panel = document.getElementById('editor-panel');
		dragging = true;
		startY = e.clientY;
		startHeight = panel.offsetHeight;
		e.preventDefault();
	});

	document.addEventListener('mousemove', e => {
		if (!dragging) return;
		const panel = document.getElementById('editor-panel');
		const container = panel.parentElement;
		const delta = e.clientY - startY; // drag down = increase height
		const newHeight = Math.min(
			container.offsetHeight - 80,   // leave at least 80px of terminal
			Math.max(80, startHeight + delta)
		);
		panel.style.height = newHeight + 'px';
		fit_addon.fit();
		startY = e.clientY;
		startHeight = newHeight;
	});

	document.addEventListener('mouseup', () => { dragging = false; });
})();

async function sendToBBS() {
	let txt = document.getElementById('scratchpad').value;
	if (!txt) return;
	try { txt = await shortenUrlsInText(txt); } catch (e) { console.error('KOIC: shorten error', e); }
	// Always send as __DRAFT__: — the Perl __DRAFT__ handler covers both new posts
	// and re-edits. The old __REPLACE__: path had no Perl handler and was a bug.
	socket_obj.send("__DRAFT__:" + txt);
	draft_edit_mode = false;
	hideEditorPanel();
}