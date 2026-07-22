/**
 * Single-file chat frontend for NextGig, served by agent/webserver.ts.
 *
 * Kept as an inlined string (rather than a static file) so it ships inside the
 * agent/ bundle and needs no extra COPY on the read-only production filesystem.
 */

// String.raw so the client-side markdown regex LITERALS below survive verbatim
// (a normal template literal would mangle their backslashes, and new RegExp
// strings would be double-escaped). The template is kept PURE ASCII on purpose:
// under String.raw, Bun emits any non-ASCII char as visible "\u...." text, so
// icons/illustrations are inline SVG and punctuation is ASCII. Do NOT add
// non-ASCII characters or ${...} interpolation to this template.
export const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>NextGig</title>
<style>
  :root {
    --bg: #0b0d14; --panel: #141826; --panel-2: #1b2032; --line: #262c40;
    --text: #eef1f8; --muted: #98a2b8;
    --v1: #7c5cff; --v2: #ff5c9d; --teal: #2ee6c8; --blue: #4f9cf9;
    --grad: linear-gradient(135deg, #7c5cff, #ff5c9d);
    --grad-teal: linear-gradient(135deg, #2ee6c8, #4f9cf9);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--text);
    display: flex; flex-direction: column;
    background:
      radial-gradient(1100px 620px at 12% -12%, rgba(124,92,255,.20), transparent 60%),
      radial-gradient(900px 560px at 112% 114%, rgba(46,230,200,.14), transparent 55%),
      var(--bg);
  }
  ::selection { background: rgba(124,92,255,.35); }

  header {
    padding: 13px 20px; display: flex; align-items: center; gap: 11px;
    border-bottom: 1px solid var(--line);
    background: rgba(12,14,22,.6); backdrop-filter: blur(10px);
    position: sticky; top: 0; z-index: 5;
  }
  .logo { display: grid; place-items: center; }
  header h1 {
    font-size: 17px; margin: 0; font-weight: 800; letter-spacing: .2px;
    background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  header .sub { color: var(--muted); font-size: 12px; margin-left: auto; }

  #main { flex: 1; overflow-y: auto; }
  .wrap { width: 100%; max-width: 780px; margin: 0 auto; padding: 0 20px; }
  #chat { display: flex; flex-direction: column; gap: 16px; padding: 22px 0 8px; }

  .msg { display: flex; gap: 12px; animation: rise .28s cubic-bezier(.2,.7,.3,1) both; }
  .msg .avatar {
    width: 32px; height: 32px; border-radius: 10px; flex: 0 0 32px; display: grid; place-items: center;
    color: #fff; background: var(--grad); box-shadow: 0 4px 12px rgba(124,92,255,.35);
  }
  .msg.user .avatar { background: var(--grad-teal); box-shadow: 0 4px 12px rgba(46,230,200,.28); }
  .msg .bubble {
    background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 11px 15px;
    white-space: pre-wrap; word-wrap: break-word; max-width: calc(100% - 52px);
    box-shadow: 0 2px 10px rgba(0,0,0,.18);
  }
  .msg.user { flex-direction: row-reverse; }
  .msg.user .bubble {
    background: var(--grad); border: none; color: #fff; white-space: pre-wrap;
    box-shadow: 0 6px 18px rgba(124,92,255,.35);
  }
  .attach { font-size: 13px; opacity: .95; display: inline-flex; align-items: center; gap: 6px; }
  .attach b { font-weight: 700; }

  /* Rendered markdown in bot bubbles */
  .msg.bot .bubble { white-space: normal; }
  .bubble p { margin: 0 0 8px; }
  .bubble p:last-child { margin-bottom: 0; }
  .bubble ul, .bubble ol { margin: 6px 0; padding-left: 20px; }
  .bubble li { margin: 3px 0; }
  .bubble strong { font-weight: 700; }
  .bubble code {
    background: rgba(124,92,255,.14); border: 1px solid var(--line); border-radius: 6px; padding: 1px 5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
  }
  .msg.bot .bubble a { color: var(--teal); text-decoration: none; border-bottom: 1px solid rgba(46,230,200,.4); }
  .msg.bot .bubble a:hover { border-bottom-color: var(--teal); }
  .msg.user .bubble a { color: #fff; text-decoration: underline; }
  .bubble .md-h { font-weight: 800; margin: 8px 0 4px; }

  .typing .bubble { color: var(--muted); }
  .dots span {
    display: inline-block; width: 7px; height: 7px; margin: 0 2px; border-radius: 50%;
    background: var(--grad); animation: blink 1.2s infinite both;
  }
  .dots span:nth-child(2){ animation-delay: .18s } .dots span:nth-child(3){ animation-delay: .36s }
  @keyframes blink { 0%,80%,100%{opacity:.25} 40%{opacity:1} }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }

  /* Hero / empty state */
  #hero { text-align: center; padding: 8vh 20px 6vh; animation: rise .4s ease both; }
  .hero-art { animation: float 5s ease-in-out infinite; filter: drop-shadow(0 12px 30px rgba(124,92,255,.3)); }
  #hero h2 {
    font-size: 30px; margin: 18px 0 6px; font-weight: 800; letter-spacing: -.4px;
    background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  #hero p { color: var(--muted); max-width: 460px; margin: 0 auto 22px; font-size: 15px; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; }
  .chip {
    display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font: inherit; font-size: 13.5px;
    color: var(--text); background: var(--panel-2); border: 1px solid var(--line);
    padding: 9px 15px; border-radius: 999px; transition: transform .12s, border-color .12s, background .12s;
  }
  .chip:hover { transform: translateY(-2px); border-color: var(--v1); background: rgba(124,92,255,.12); }
  .chip svg { color: var(--v1); }

  /* Composer */
  footer { padding: 12px 0 16px; }
  .composer {
    display: flex; align-items: flex-end; gap: 6px;
    background: var(--panel-2); border: 1px solid var(--line); border-radius: 22px; padding: 6px;
    box-shadow: 0 10px 34px rgba(0,0,0,.32);
  }
  .composer:focus-within { border-color: var(--v1); box-shadow: 0 10px 34px rgba(124,92,255,.22); }
  .composer textarea {
    flex: 1; resize: none; background: transparent; border: none; color: var(--text); font: inherit;
    padding: 9px 6px; max-height: 150px; min-height: 28px; line-height: 1.4;
  }
  .composer textarea:focus { outline: none; }
  .composer textarea::placeholder { color: var(--muted); }
  .attach-btn, .send-btn { border: none; cursor: pointer; border-radius: 16px; height: 40px; display: grid; place-items: center; font: inherit; }
  .attach-btn { width: 40px; background: transparent; color: var(--muted); transition: background .12s, color .12s; }
  .attach-btn:hover { background: rgba(255,255,255,.06); color: var(--text); }
  .send-btn { width: 46px; color: #fff; background: var(--grad); box-shadow: 0 5px 16px rgba(124,92,255,.42); transition: transform .1s, filter .1s; }
  .send-btn:hover { filter: brightness(1.08); }
  .send-btn:active { transform: scale(.93); }
  .attach-btn:disabled, .send-btn:disabled { opacity: .5; cursor: default; }
  .hint { color: var(--muted); font-size: 12px; text-align: center; margin-top: 9px; }
  input[type=file] { display: none; }

  /* Drag & drop overlay */
  #drop-overlay {
    position: fixed; inset: 0; background: rgba(11,13,20,.86); border: 3px dashed var(--v1);
    display: none; place-items: center; z-index: 30; font-size: 18px; font-weight: 600; color: var(--text);
  }
  #drop-overlay.show { display: grid; }

  /* Settings modal */
  .gearbtn { background: transparent; border: none; color: var(--muted); padding: 0 4px; height: auto; cursor: pointer; transition: color .12s, transform .3s; }
  .gearbtn:hover { color: var(--text); transform: rotate(45deg); }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none; place-items: center; z-index: 40; }
  .modal-overlay.show { display: grid; animation: rise .2s ease both; }
  .modal { width: min(440px, calc(100% - 32px)); background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 20px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
  .modal-head { display: flex; align-items: center; justify-content: space-between; }
  .modal-head b { font-size: 16px; }
  .modal .x { background: transparent; border: none; color: var(--muted); padding: 4px; height: auto; cursor: pointer; }
  .modal .x:hover { color: var(--text); }
  .modal label { display: block; font-size: 12px; color: var(--muted); margin: 13px 0 5px; }
  .modal input { width: 100%; background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 10px; padding: 10px 11px; font: inherit; }
  .modal input:focus { outline: none; border-color: var(--v1); }
  .modal-actions { margin-top: 17px; }
  .modal-actions button { width: 100%; height: 44px; border: none; border-radius: 12px; cursor: pointer; font: inherit; font-weight: 700; color: #fff; background: var(--grad); box-shadow: 0 6px 18px rgba(124,92,255,.4); }
  .modal-actions button:hover { filter: brightness(1.08); }
  .modal-actions button:disabled { opacity: .5; cursor: default; }
  .modal-status { font-size: 13px; color: var(--text); margin: 7px 0 0; }
  .modal-note { font-size: 13px; color: var(--muted); margin: 11px 0 0; min-height: 18px; }
  .modal-hint { font-size: 12px; color: var(--muted); margin: 11px 0 0; }
  .modal-hint a { color: var(--teal); }

  svg { stroke-linecap: round; stroke-linejoin: round; }
  .avatar svg, .gearbtn svg, .attach-btn svg, .send-btn svg, .modal .x svg { display: block; }
</style>
</head>
<body>
<header>
  <span class="logo"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke-width="2.2"><defs><linearGradient id="lg" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse"><stop stop-color="#7c5cff"/><stop offset="1" stop-color="#ff5c9d"/></linearGradient></defs><g stroke="url(#lg)"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/></g><circle cx="12" cy="12" r="1.7" fill="url(#lg)"/></svg></span>
  <h1>NextGig</h1>
  <button class="gearbtn" id="settings-btn" title="Email settings" aria-label="Email settings"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
</header>

<main id="main">
  <div class="wrap">
    <div id="hero">
      <svg class="hero-art" viewBox="0 0 160 160" width="132" height="132" fill="none">
        <defs>
          <linearGradient id="hg" x1="10" y1="10" x2="150" y2="150" gradientUnits="userSpaceOnUse"><stop stop-color="#7c5cff"/><stop offset="1" stop-color="#ff5c9d"/></linearGradient>
          <linearGradient id="hg2" x1="90" y1="90" x2="150" y2="150" gradientUnits="userSpaceOnUse"><stop stop-color="#2ee6c8"/><stop offset="1" stop-color="#4f9cf9"/></linearGradient>
        </defs>
        <circle cx="74" cy="74" r="60" fill="url(#hg)" opacity="0.12"/>
        <g stroke="url(#hg)" stroke-width="4.5"><circle cx="70" cy="70" r="36"/><circle cx="70" cy="70" r="22"/></g>
        <circle cx="70" cy="70" r="8" fill="url(#hg)"/>
        <line x1="98" y1="98" x2="132" y2="132" stroke="url(#hg2)" stroke-width="10"/>
        <path d="M128 34 l3.5 9 9 3.5 -9 3.5 -3.5 9 -3.5 -9 -9 -3.5 9 -3.5z" fill="url(#hg)"/>
        <path d="M30 112 l2.5 6.5 6.5 2.5 -6.5 2.5 -2.5 6.5 -2.5 -6.5 -6.5 -2.5 6.5 -2.5z" fill="url(#hg2)"/>
      </svg>
      <h2>Find your next role</h2>
      <p>Upload your LinkedIn PDF or CV and I'll build your skill matrix, then hunt for matching jobs and email you the new ones.</p>
      <div class="chips">
        <button class="chip" id="chip-upload"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg> Upload PDF</button>
        <button class="chip" id="chip-paste">Paste my profile</button>
        <button class="chip" id="chip-help">What can you do?</button>
      </div>
    </div>
    <div id="chat"></div>
  </div>
</main>

<footer>
  <div class="wrap">
    <div class="composer">
      <button class="attach-btn" id="attach" title="Upload LinkedIn PDF or CV" aria-label="Upload PDF"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
      <textarea id="input" rows="1" placeholder="Message NextGig...  (paste your profile, ask about jobs, or set up alerts)"></textarea>
      <button class="send-btn" id="send" title="Send" aria-label="Send"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg></button>
    </div>
    <div class="hint">Tip: LinkedIn profile -&gt; More -&gt; Save to PDF, then drop it anywhere here.</div>
  </div>
</footer>

<div id="drop-overlay">Drop your PDF to build your skill matrix</div>

<div id="settings-overlay" class="modal-overlay">
  <div class="modal">
    <div class="modal-head"><b>Email settings</b><button class="x" id="settings-close" title="Close" aria-label="Close"><svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/></svg></button></div>
    <p class="modal-status" id="email-status">Loading...</p>
    <label for="rk">Resend API key</label>
    <input id="rk" type="password" autocomplete="off" placeholder="re_... (leave blank to keep current)" />
    <label for="rf">From address (optional)</label>
    <input id="rf" type="text" placeholder="NextGig &lt;onboarding@resend.dev&gt;" />
    <label for="rt">Send a test to</label>
    <input id="rt" type="email" placeholder="you@example.com" />
    <div class="modal-actions"><button id="save-test">Save &amp; send test</button></div>
    <p class="modal-note" id="email-note"></p>
    <p class="modal-hint">Get a free key at <a href="https://resend.com" target="_blank" rel="noopener noreferrer">resend.com</a>. Until you verify a domain in Resend, the default sender can only email your own Resend account address.</p>
  </div>
</div>

<script>
  const main = document.getElementById('main');
  const chat = document.getElementById('chat');
  const hero = document.getElementById('hero');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const attachBtn = document.getElementById('attach');
  const fileInput = document.getElementById('file') || (function () {
    const f = document.createElement('input'); f.type = 'file'; f.id = 'file'; f.accept = 'application/pdf'; document.body.appendChild(f); return f;
  })();
  const overlay = document.getElementById('drop-overlay');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsOverlay = document.getElementById('settings-overlay');
  const settingsClose = document.getElementById('settings-close');
  const rk = document.getElementById('rk');
  const rf = document.getElementById('rf');
  const rt = document.getElementById('rt');
  const emailStatusEl = document.getElementById('email-status');
  const emailNote = document.getElementById('email-note');
  const saveTestBtn = document.getElementById('save-test');
  let busy = false;
  let heroHidden = false;

  // Inline SVG icons used from JS (avatars, upload bubble). ASCII only.
  const ICON_BOT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/></svg>';
  const ICON_USER = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';
  const ICON_CLIP = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // Minimal, XSS-safe markdown renderer for bot messages. Input is HTML-escaped
  // first, then a whitelisted set of transforms introduces tags.
  var PH = String.fromCharCode(57344); // sentinel char, will not appear in real text
  var BT = String.fromCharCode(96);    // backtick
  function mdInline(t) {
    var store = [];
    function stash(html) { store.push(html); return PH + (store.length - 1) + PH; }
    t = t.replace(new RegExp(BT + '([^' + BT + ']+)' + BT, 'g'), function (_, c) { return stash('<code>' + c + '</code>'); });
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, txt, u) {
      return stash('<a href="' + u.replace(/"/g, '%22') + '" target="_blank" rel="noopener noreferrer">' + txt + '</a>');
    });
    t = t.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, function (u) {
      return stash('<a href="' + u.replace(/"/g, '%22') + '" target="_blank" rel="noopener noreferrer">' + u + '</a>');
    });
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    t = t.replace(new RegExp(PH + '(\\d+)' + PH, 'g'), function (_, i) { return store[+i]; });
    return t;
  }
  function md(src) {
    var lines = esc(src).split(/\r?\n/);
    var out = [], para = [], list = null;
    function flushPara() { if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; } }
    function flushList() {
      if (list) { out.push('<' + list.t + '>' + list.items.map(function (it) { return '<li>' + mdInline(it) + '</li>'; }).join('') + '</' + list.t + '>'); list = null; }
    }
    for (var k = 0; k < lines.length; k++) {
      var line = lines[k].replace(/\s+$/, '');
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      var ul = line.match(/^\s*[-*+]\s+(.*)$/);
      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (h) { flushPara(); flushList(); out.push('<div class="md-h">' + mdInline(h[2]) + '</div>'); continue; }
      if (ul) { flushPara(); if (!list || list.t !== 'ul') { flushList(); list = { t: 'ul', items: [] }; } list.items.push(ul[1]); continue; }
      if (ol) { flushPara(); if (!list || list.t !== 'ol') { flushList(); list = { t: 'ol', items: [] }; } list.items.push(ol[1]); continue; }
      if (line.trim() === '') { flushPara(); flushList(); continue; }
      flushList(); para.push(line);
    }
    flushPara(); flushList();
    return out.join('');
  }

  function hideHero() { if (heroHidden) return; heroHidden = true; hero.style.display = 'none'; }

  function addMsg(role, html) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    const avatar = role === 'user' ? ICON_USER : ICON_BOT;
    wrap.innerHTML = '<div class="avatar">' + avatar + '</div><div class="bubble">' + html + '</div>';
    chat.appendChild(wrap);
    main.scrollTop = main.scrollHeight;
    return wrap;
  }

  function addTyping() {
    const wrap = document.createElement('div');
    wrap.className = 'msg bot typing';
    wrap.innerHTML = '<div class="avatar">' + ICON_BOT + '</div>' +
      '<div class="bubble dots"><span></span><span></span><span></span></div>';
    chat.appendChild(wrap);
    main.scrollTop = main.scrollHeight;
    return wrap;
  }

  function setBusy(b) { busy = b; sendBtn.disabled = b; attachBtn.disabled = b; }

  // Consume a streamed NDJSON response (see agent/webserver.ts). Shows the typing
  // dots until the first delta, then converts to a bot bubble that grows as
  // tokens stream in. Events: {t:'delta'|'ping'|'done'|'error', v?}.
  async function consumeStream(resp, fallback) {
    const typing = addTyping();
    let bubble = null, acc = '';
    function ensureBubble() {
      if (bubble) return bubble;
      typing.remove();
      const wrap = addMsg('bot', '');
      bubble = wrap.querySelector('.bubble');
      return bubble;
    }
    function render() { ensureBubble().innerHTML = md(acc); main.scrollTop = main.scrollHeight; }

    if (!resp.body) { typing.remove(); addMsg('bot', md(fallback)); return; }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', errMsg = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
          if (ev.t === 'delta') { acc += ev.v; render(); }
          else if (ev.t === 'error') { errMsg = ev.v || fallback; }
          // 'ping' and 'done' need no action
        }
      }
    } catch (e) {
      if (!acc) { typing.remove(); addMsg('bot', md('Network error - please try again.')); return; }
      errMsg = errMsg || 'The connection dropped before the reply finished.';
    }
    if (errMsg && !acc) { typing.remove(); addMsg('bot', md(errMsg)); return; }
    if (errMsg) { acc += '\n\n_' + errMsg + '_'; render(); return; }
    if (!acc) { typing.remove(); addMsg('bot', md(fallback)); return; }
    render();
  }

  async function sendMessage(text) {
    if (busy || !text.trim()) return;
    hideHero();
    addMsg('user', esc(text));
    input.value = ''; autoGrow();
    setBusy(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (r.status === 400) { const d = await r.json().catch(() => ({})); addMsg('bot', md(d.error || 'Something went wrong.')); return; }
      await consumeStream(r, 'Something went wrong.');
    } catch (e) {
      addMsg('bot', md('Network error - please try again.'));
    } finally { setBusy(false); input.focus(); }
  }

  async function uploadPdf(file) {
    if (busy || !file) return;
    if (file.type !== 'application/pdf') { hideHero(); addMsg('bot', 'Please upload a PDF file.'); return; }
    hideHero();
    addMsg('user', '<span class="attach">' + ICON_CLIP + ' <b>' + esc(file.name) + '</b></span>');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('pdf', file);
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      // Non-stream JSON errors (bad/empty/too-large PDF) come back as 400/500.
      const ct = r.headers.get('Content-Type') || '';
      if (ct.indexOf('application/x-ndjson') === -1) {
        const d = await r.json().catch(() => ({}));
        addMsg('bot', md(d.error || 'Could not read that PDF.'));
        return;
      }
      await consumeStream(r, 'Could not read that PDF.');
    } catch (e) {
      addMsg('bot', md('Upload failed - please try again.'));
    } finally { setBusy(false); input.focus(); }
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  }

  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input.value); }
  });
  sendBtn.addEventListener('click', () => sendMessage(input.value));
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) uploadPdf(fileInput.files[0]); fileInput.value = ''; });

  // Hero quick-start chips
  document.getElementById('chip-upload').addEventListener('click', () => fileInput.click());
  document.getElementById('chip-paste').addEventListener('click', () => { input.focus(); });
  document.getElementById('chip-help').addEventListener('click', () => sendMessage('What can you do?'));

  // Drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; overlay.classList.add('show'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => { dragDepth--; if (dragDepth <= 0) overlay.classList.remove('show'); });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; overlay.classList.remove('show');
    const f = e.dataTransfer.files[0]; if (f) uploadPdf(f);
  });

  // Settings (email / Resend)
  async function loadEmailStatus() {
    emailNote.textContent = '';
    try {
      const s = await (await fetch('/api/email-config')).json();
      if (s.configured) {
        emailStatusEl.textContent = 'Configured' + (s.source === 'env' ? ' (server secret)' : '') + ' - From: ' + s.from
          + (s.usingDefaultFrom ? ' (test sender)' : '');
      } else {
        emailStatusEl.textContent = 'Not configured - add a Resend API key to enable email digests.';
      }
      if (s.from) rf.value = s.from;
      rk.placeholder = s.source === 'env'
        ? 'Set via server secret (RESEND_API_KEY)'
        : 're_... (leave blank to keep current)';
    } catch (e) { emailStatusEl.textContent = 'Could not load status.'; }
  }
  function openSettings() { settingsOverlay.classList.add('show'); loadEmailStatus(); }
  function closeSettings() { settingsOverlay.classList.remove('show'); }
  settingsBtn.addEventListener('click', openSettings);
  settingsClose.addEventListener('click', closeSettings);
  settingsOverlay.addEventListener('click', (e) => { if (e.target === settingsOverlay) closeSettings(); });

  saveTestBtn.addEventListener('click', async () => {
    saveTestBtn.disabled = true;
    emailNote.textContent = 'Saving...';
    try {
      await fetch('/api/email-config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: rk.value, from: rf.value }),
      });
      rk.value = '';
      const to = rt.value.trim();
      if (!to) { emailNote.textContent = 'Saved. Enter a "send a test to" address to verify delivery.'; await loadEmailStatus(); return; }
      emailNote.textContent = 'Sending test...';
      const d = await (await fetch('/api/email-test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to }),
      })).json();
      emailNote.textContent = d.ok ? ('Test sent to ' + d.sentTo + ' - check the inbox.') : ('Could not send: ' + (d.error || 'test failed.'));
      await loadEmailStatus();
    } catch (e) {
      emailNote.textContent = 'Something went wrong - please try again.';
    } finally { saveTestBtn.disabled = false; }
  });

  input.focus();
</script>
</body>
</html>`;
