# KOIC — Kevin's Own ISCABBS Client

A web-based client for [ISCABBS](https://bbs.iscabbs.com) (bbs.iscabbs.com),
implemented as a Perl/Mojolicious WebSocket proxy with an xterm.js browser
frontend. No installation required on the user side — just a browser.

## Two Variants

**Desktop** (`koic-desktop/`) — Full-featured client with a sidebar navigation
panel, font selection, drag-to-resize post editor, and a blocked-message viewer.

**Mobile** (`koic-mobile/`) — Optimized for narrow viewports with a reading pane
that reformats BBS output for small screens, a NEXT/SPACE bar, and a scratchpad
post editor.

## Features

- Full DOC (Dave's Own Citadel) protocol support including ISCA client handshake
- ANSI color rendering via xterm.js
- Enemy list: block posts and Xpress messages from specific users
- Auto-login with username and password
- Local post editor with word wrap at 78 columns
- TinyURL integration for shortening long URLs in posts
- Mobile reading pane with ANSI color support
- Screen reader accessibility (ARIA live regions)

## Requirements

- Perl with [Mojolicious](https://mojolicious.org)
- A server or local machine to run the proxy

## Quick Start

```bash
# Desktop (runs on port 17258)
cd koic-desktop
perl koic-d.pl

# Mobile (runs on port 17259)
cd koic-mobile
perl koic-m.pl
```

Then open your browser to `http://localhost:17258` (desktop) or
`http://localhost:17259` (mobile).

## Public Instances

- Desktop: http://bbs.dawoods.com
- Mobile: http://bbs-mobile.dawoods.com

## Author

Kevin Crawley (DrMemory)

## License

MIT — see [LICENSE](LICENSE)
