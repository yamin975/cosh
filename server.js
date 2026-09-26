// =============================================================================
// Code Tent - a realtime, ephemeral code-sharing chat room ("Tent").
// Each Tent has its own URL, its own in-memory message history, and its own
// randomly-generated visual theme derived from its ID.
// =============================================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app); // raw HTTP server so socket.io can attach to it

// Socket.IO setup.
// transports: ['polling'] forces long-polling instead of WebSockets, because
// Render's free-tier proxy has historically dropped/crashed WebSocket
// connections. Polling is slightly slower but far more reliable there.
const io = new Server(server, {
    transports: ['polling'],
    cors: {
        origin: "*",      // allow any origin to connect (fine for a public demo app)
        methods: ["GET", "POST"]
    }
});

// In-memory "database": { [tentId]: { messages: [...], lastActive: timestamp } }
// NOTE: this is not persistent. If the server restarts, all tents and their
// message history are lost. Fine for a scratchpad app, not for anything durable.
const database = {};

// =============================================================================
// THEME ENGINE
//
// Every Tent ID deterministically maps to a "theme" (colors, fonts, layout
// details). We hash the tentId into a numeric seed, then feed that seed into
// a seeded pseudo-random number generator (mulberry32) so the sequence of
// "random" choices is 100% reproducible for a given tentId.
//
// Why deterministic instead of truly random per page load?
//   - Everyone inside the same Tent must see the same look.
//   - A fresh random Tent ID (crypto.randomBytes) still produces a
//     effectively-random theme, since the ID itself is random.
//
// The combined space of hue (360) x hue offset (~90) x fonts (7 x 5) x
// pattern (4) x button style (3) x corner radius (5) x gradient angle (360)
// works out to several million distinct visual combinations, so two
// different Tents landing on an identical look is very unlikely.
// =============================================================================

// Simple, fast string hash (FNV-1a variant). Turns the tentId string into a
// single 32-bit unsigned integer we can use as a seed.
function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0; // force unsigned 32-bit
}

// mulberry32: a small, fast seeded PRNG. Given the same seed it always
// produces the same sequence of numbers in [0, 1), which is exactly what we
// want for "same tentId -> same theme every time".
function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Pools of options the theme engine picks from.
const HEADING_FONTS = ['Space Grotesk', 'Sora', 'Outfit', 'Manrope', 'Plus Jakarta Sans', 'DM Sans', 'Unbounded'];
const MONO_FONTS = ['JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Space Mono', 'Roboto Mono'];
const PATTERNS = ['dots', 'grid', 'diagonal', 'none'];
const BUTTON_STYLES = ['rounded', 'pill', 'sharp'];
const RADII = [6, 10, 14, 18, 24];

// Picks a random element from an array using the given PRNG function.
function pick(rand, arr) {
    return arr[Math.floor(rand() * arr.length)];
}

// Builds a full theme object for a given tentId. This is the single source
// of truth for "what does this Tent look like".
function generateTheme(tentId) {
    const rand = mulberry32(hashString(tentId));

    const hue = Math.floor(rand() * 360);                       // primary accent hue
    const hue2 = (hue + 30 + Math.floor(rand() * 90)) % 360;     // secondary hue, offset from the first for contrast
    const angle = Math.floor(rand() * 360);                      // background gradient angle
    const sat = 55 + Math.floor(rand() * 25);                    // saturation, kept in a pleasant mid-high range
    const accentLight = 58 + Math.floor(rand() * 14);            // lightness, kept readable against the dark background

    return {
        hue,
        hue2,
        angle,
        sat,
        accentLight,
        headingFont: pick(rand, HEADING_FONTS),
        monoFont: pick(rand, MONO_FONTS),
        pattern: pick(rand, PATTERNS),
        buttonStyle: pick(rand, BUTTON_STYLES),
        radius: pick(rand, RADII)
    };
}

// Builds the Google Fonts stylesheet URL for the two fonts a theme picked.
function fontUrl(theme) {
    const h = theme.headingFont.replace(/ /g, '+');
    const m = theme.monoFont.replace(/ /g, '+');
    return `https://fonts.googleapis.com/css2?family=${h}:wght@400;600;700&family=${m}:wght@400;500&display=swap`;
}

// Translates the theme's abstract "buttonStyle" into an actual CSS radius.
function buttonRadiusCss(theme) {
    if (theme.buttonStyle === 'pill') return '999px';   // fully rounded ends
    if (theme.buttonStyle === 'sharp') return '3px';    // near-square corners
    return theme.radius + 'px';                         // 'rounded' reuses the card radius
}

// Builds the two pieces (image + matching size) needed to layer a subtle
// pattern *on top of* the background gradient, rather than replacing it.
// Returns arrays so the caller can prepend/append the gradient layer and
// keep the background-image/background-size lists in sync (each layer in
// background-image needs a matching entry in background-size).
function patternLayer(theme) {
    const c = `hsla(${theme.hue}, ${theme.sat}%, 65%, 0.06)`;
    switch (theme.pattern) {
        case 'dots':
            return {
                images: [`radial-gradient(${c} 1.5px, transparent 1.5px)`],
                sizes: ['22px 22px']
            };
        case 'grid':
            return {
                images: [
                    `linear-gradient(${c} 1px, transparent 1px)`,
                    `linear-gradient(90deg, ${c} 1px, transparent 1px)`
                ],
                sizes: ['32px 32px', '32px 32px']
            };
        case 'diagonal':
            return {
                images: [`repeating-linear-gradient(45deg, ${c} 0, ${c} 1px, transparent 1px, transparent 14px)`],
                sizes: ['auto']
            };
        default:
            return { images: [], sizes: [] }; // 'none' - no extra layer
    }
}

// =============================================================================
// ROUTES
// =============================================================================

// Visiting the bare domain creates a brand-new random Tent and redirects to it.
app.get('/', (req, res) => {
    const randomTentId = crypto.randomBytes(4).toString('hex'); // 8 hex chars, e.g. "a1b2c3d4"
    res.redirect('/tent/' + randomTentId);
});

// Used by the "+ Pitch New Tent" button to open another Tent in a new tab
// without reloading the current page.
app.get('/api/new-tent', (req, res) => {
    const randomTentId = crypto.randomBytes(4).toString('hex');
    res.json({ tentId: randomTentId });
});

// Backward compatibility: anyone with an old "/room/:id" link (from before
// the Room -> Tent rename) gets redirected to the equivalent "/tent/:id"
// URL instead of hitting a 404.
app.get('/room/:tentId', (req, res) => {
    res.redirect('/tent/' + req.params.tentId);
});

// Main page: renders the whole chat UI as one self-contained HTML document,
// with the theme baked in as CSS variables computed server-side from the
// tentId. Because the theme is computed here (not in the browser), everyone
// who loads this Tent gets the exact same look without any extra round-trip.
app.get('/tent/:tentId', (req, res) => {
    const tentId = req.params.tentId;
    const theme = generateTheme(tentId);

    // Combine the pattern layer (if any) with the base gradient into single
    // background-image / background-size lists. The pattern images (if
    // present) come FIRST so they render on top of the gradient beneath them.
    const pattern = patternLayer(theme);
    const gradientImage = `linear-gradient(${theme.angle}deg, var(--bg-deep), var(--bg-deep2), var(--bg-deep))`;
    const bgImages = [...pattern.images, gradientImage].join(', ');
    const bgSizes = [...pattern.sizes, '200% 200%'].join(', ');

    const html = `<!DOCTYPE html>
<html lang="en" data-theme-pattern="${theme.pattern}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cosh Tent - ${tentId}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${fontUrl(theme)}" rel="stylesheet">
<style>
  /* CSS custom properties carry the generated theme through the whole
     stylesheet below, so every rule reads from a single source of truth. */
  :root {
    --hue: ${theme.hue};
    --hue2: ${theme.hue2};
    --sat: ${theme.sat}%;
    --accent: hsl(${theme.hue}, ${theme.sat}%, ${theme.accentLight}%);
    --accent2: hsl(${theme.hue2}, ${theme.sat}%, ${theme.accentLight}%);
    --accent-soft: hsla(${theme.hue}, ${theme.sat}%, ${theme.accentLight}%, 0.15);
    --bg-deep: hsl(${theme.hue}, 35%, 6%);
    --bg-deep2: hsl(${theme.hue2}, 30%, 9%);
    --radius: ${theme.radius}px;
    --btn-radius: ${buttonRadiusCss(theme)};
    --font-head: '${theme.headingFont}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --font-mono: '${theme.monoFont}', 'Courier New', monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    padding: 20px;
    font-family: var(--font-head);
    color: #e8e8ea;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    /* Explicit dark fallback color - guarantees the page is never white,
       even for a split second before the gradient below paints. */
    background-color: var(--bg-deep);
    /* Layered background: the pattern texture (if any) sits on top of the
       slowly drifting gradient underneath it. Both live in the SAME
       background-image/background-size declarations so the pattern can
       never accidentally replace the gradient. */
    background-image: ${bgImages};
    background-size: ${bgSizes};
    animation: driftBg 22s ease-in-out infinite;
  }
  @keyframes driftBg {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--accent-soft);
  }
  .tent-title { display: flex; align-items: center; gap: 10px; }
  .tent-title h2 {
    margin: 0;
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 20px;
    color: var(--accent);
    letter-spacing: 0.3px;
  }
  .tent-emoji { font-size: 22px; filter: drop-shadow(0 0 6px var(--accent-soft)); }
  .share-url { font-size: 12px; color: #9a9aa2; margin-top: 4px; word-break: break-all; }
  .header-actions { display: flex; align-items: center; gap: 12px; }
  /* Connection status dot, colored green/red via the .disconnected class
     which is toggled from the client-side socket 'connect'/'disconnect' events. */
  #status { font-size: 12px; color: #6adf8f; display: flex; align-items: center; gap: 6px; }
  #status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #6adf8f; box-shadow: 0 0 6px #6adf8f; }
  #status.disconnected { color: #f45f5f; }
  #status.disconnected::before { background: #f45f5f; box-shadow: 0 0 6px #f45f5f; }

  button {
    background: rgba(255,255,255,0.04);
    color: #f0f0f2;
    border: 1px solid var(--accent-soft);
    padding: 8px 14px;
    border-radius: var(--btn-radius); /* shape driven by the theme's buttonStyle */
    cursor: pointer;
    font-size: 13px;
    font-family: var(--font-head);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: transform 0.12s ease, background 0.15s ease, border-color 0.15s ease;
  }
  button:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateY(-1px); }
  button:active { transform: translateY(0); }

  .new-tent-btn { color: var(--accent2); border-color: var(--accent2); }

  /* Scrollable message list. */
  #chat-window {
    flex: 1;
    overflow-y: auto;
    margin: 20px 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-right: 6px;
  }
  #chat-window::-webkit-scrollbar { width: 8px; }
  #chat-window::-webkit-scrollbar-thumb { background: var(--accent-soft); border-radius: 8px; }

  /* One shared code snippet, rendered as a "glass" card. */
  .msg-card {
    background: rgba(255,255,255,0.035);
    border: 1px solid rgba(255,255,255,0.08);
    border-left: 3px solid var(--accent); /* accent stripe ties each card back to the theme */
    border-radius: var(--radius);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    backdrop-filter: blur(6px);
    animation: fadeIn 0.25s ease; /* small entrance animation when a message arrives */
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .msg-meta { font-size: 11px; color: #8f8f98; display: flex; justify-content: space-between; }
  .msg-body {
    font-family: var(--font-mono);
    background: rgba(0,0,0,0.35);
    color: #e2e2e6;
    padding: 12px;
    border-radius: calc(var(--radius) - 4px);
    white-space: pre-wrap;   /* preserve line breaks/indentation in pasted code */
    word-break: break-word;
    font-size: 13px;
    line-height: 1.5;
  }
  .msg-actions { display: flex; gap: 10px; align-items: center; }
  .upvote-btn { border-color: rgba(120,200,140,0.4); color: #a3e6b5; }
  .upvote-btn:hover { background: rgba(120,200,140,0.15); }
  .copy-btn { border-color: rgba(120,170,220,0.4); color: #a9cdf0; }
  .copy-btn:hover { background: rgba(120,170,220,0.15); }

  /* Bottom compose bar. */
  .input-area { display: flex; gap: 10px; min-height: 84px; }
  textarea {
    flex: 1;
    background: rgba(255,255,255,0.04);
    color: #fff;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: var(--radius);
    padding: 12px;
    font-family: var(--font-mono);
    font-size: 13px;
    resize: none;
    outline: none;
    transition: border-color 0.15s ease;
  }
  textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  textarea::placeholder { color: #7c7c86; }

  .send-btn {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    border: none;
    padding: 0 26px;
    font-weight: 700;
    color: #111;
    font-size: 14px;
  }
  .send-btn:hover { filter: brightness(1.08); transform: translateY(-1px); }

  /* Stack the compose bar on small screens instead of squeezing it sideways. */
  @media (max-width: 640px) {
    body { padding: 12px; }
    .input-area { flex-direction: column; min-height: auto; }
    .send-btn { padding: 12px; }
  }
</style>
</head>
<body>
  <header>
    <div class="tent-title">
      <span class="tent-emoji">&#9978;</span>
      <div>
        <h2>Tent: ${tentId}</h2>
        <div class="share-url">Share Link: <span id="urlText"></span></div>
      </div>
    </div>
    <div class="header-actions">
      <button class="new-tent-btn" id="newTentBtn">+New Tent</button>
      <div id="status">Connected</div>
    </div>
  </header>

  <div id="chat-window"></div>

  <div class="input-area">
    <textarea id="codeInput" placeholder="Your Code"></textarea>
    <button class="send-btn" id="sendBtn">Share</button>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    // ---- Client-side app logic ----
    // Long-polling only, to match the server's transport config above.
    const socket = io({ transports: ['polling'] });
    const tentId = "${tentId}"; // baked in server-side, so the client always targets this Tent

    const chatWindow = document.getElementById('chat-window');
    const codeInput = document.getElementById('codeInput');
    const sendBtn = document.getElementById('sendBtn');
    const newTentBtn = document.getElementById('newTentBtn');
    const statusEl = document.getElementById('status');

    // Show the real shareable URL (nicer than hardcoding it server-side,
    // since it correctly reflects http/https and the actual host).
    document.getElementById('urlText').textContent = window.location.href;

    // Ask the server to put us in this Tent's Socket.IO room and send us
    // the existing message history.
    socket.emit('join-tent', tentId);

    // Full history arrives once, right after joining.
    socket.on('tent-history', function (messages) {
      chatWindow.innerHTML = '';
      messages.forEach(renderMessage);
      scrollToBottom();
    });

    // A single new message arrives whenever anyone in this Tent shares code.
    socket.on('new-message', function (msg) {
      renderMessage(msg);
      scrollToBottom();
    });

    // Live upvote count updates, broadcast to everyone in the Tent.
    socket.on('update-upvotes', function (data) {
      const countSpan = document.getElementById('votes-' + data.msgId);
      if (countSpan) countSpan.textContent = data.upvotes;
    });

    // Reflect the live connection state in the header status dot.
    socket.on('connect', function () {
      statusEl.textContent = 'Connected';
      statusEl.classList.remove('disconnected');
    });
    socket.on('disconnect', function () {
      statusEl.textContent = 'Disconnected';
      statusEl.classList.add('disconnected');
    });

    // Sends the current textarea contents as a new code snippet.
    function sendMessage() {
      const code = codeInput.value.trim();
      if (!code) return; // ignore empty/whitespace-only submissions
      socket.emit('send-code', { tentId: tentId, code: code });
      codeInput.value = '';
    }

    sendBtn.addEventListener('click', sendMessage);
    // Enter sends the message; Shift+Enter inserts a newline (for multi-line code).
    codeInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Opens a brand-new random Tent in a separate tab, without losing this one.
    newTentBtn.addEventListener('click', function () {
      fetch('/api/new-tent')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          window.open('/tent/' + data.tentId, '_blank');
        });
    });

    // Builds and inserts (or replaces) the DOM for one message.
    // Uses createElement/textContent throughout instead of innerHTML string
    // concatenation, so pasted code can never be interpreted as HTML/script
    // (this is what protects against XSS from someone pasting <script> tags).
    function renderMessage(msg) {
      // If we're re-rendering an existing message (e.g. after history reload),
      // drop the old element first so we don't get duplicates.
      const existing = document.getElementById('msg-' + msg.id);
      if (existing) existing.remove();

      const localTimeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      const card = document.createElement('div');
      card.className = 'msg-card';
      card.id = 'msg-' + msg.id;

      // "Shared at HH:MM:SS" line.
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      const metaSpan = document.createElement('span');
      metaSpan.textContent = 'Shared at ' + localTimeStr;
      meta.appendChild(metaSpan);

      // The actual code snippet. textContent (not innerHTML) auto-escapes it.
      const body = document.createElement('div');
      body.className = 'msg-body';
      body.id = 'body-' + msg.id;
      body.textContent = msg.code;

      // Upvote + copy buttons.
      const actions = document.createElement('div');
      actions.className = 'msg-actions';

      const upvoteBtn = document.createElement('button');
      upvoteBtn.className = 'upvote-btn';
      const voteCount = document.createElement('span');
      voteCount.id = 'votes-' + msg.id;
      voteCount.textContent = msg.upvotes;
      upvoteBtn.textContent = '\u{1F44D} Worked (';
      upvoteBtn.appendChild(voteCount);
      upvoteBtn.appendChild(document.createTextNode(')'));
      upvoteBtn.addEventListener('click', function () { upvote(msg.id); });

      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = '\u{1F4CB} Copy Code';
      copyBtn.addEventListener('click', function () { copyCode(msg.id); });

      actions.appendChild(upvoteBtn);
      actions.appendChild(copyBtn);

      card.appendChild(meta);
      card.appendChild(body);
      card.appendChild(actions);
      chatWindow.appendChild(card);
    }

    // Tells the server this message "worked"; the server broadcasts the new
    // count back to everyone via 'update-upvotes'.
    function upvote(msgId) {
      socket.emit('upvote-code', { tentId: tentId, msgId: msgId });
    }

    // Copies a message's raw code text to the clipboard.
    function copyCode(msgId) {
      const el = document.getElementById('body-' + msgId);
      const text = el.textContent;
      navigator.clipboard.writeText(text);
    }

    // Keeps the chat window scrolled to the newest message.
    function scrollToBottom() {
      chatWindow.scrollTop = chatWindow.scrollHeight;
    }
  </script>
</body>
</html>`;

    res.send(html);
});

// =============================================================================
// SOCKET.IO EVENT HANDLERS (server side)
// =============================================================================

io.on('connection', (socket) => {
    // A client wants to enter a Tent: put their socket in that Tent's Socket.IO
    // "room" (so io.to(tentId).emit(...) reaches only people in this Tent),
    // create the Tent's storage if it doesn't exist yet, then send them the
    // existing message history.
    socket.on('join-tent', (tentId) => {
        socket.join(tentId);
        if (!database[tentId]) {
            database[tentId] = {
                messages: [],
                lastActive: Date.now()
            };
        }
        socket.emit('tent-history', database[tentId].messages);
    });

    // A client shared a new code snippet: store it and broadcast it to
    // everyone currently in that Tent (including the sender, so their own
    // message renders the same way as everyone else's).
    socket.on('send-code', (data) => {
        const tentId = data.tentId;
        if (!database[tentId]) {
            database[tentId] = { messages: [], lastActive: Date.now() };
        }

        const newMsg = {
            id: crypto.randomBytes(6).toString('hex'), // unique id for DOM targeting + upvotes
            code: data.code,
            timestamp: Date.now(),
            upvotes: 0
        };

        database[tentId].messages.push(newMsg);
        database[tentId].lastActive = Date.now();

        io.to(tentId).emit('new-message', newMsg);
    });

    // A client marked a snippet as having "worked": increment its upvote
    // count and broadcast the new total to everyone in the Tent.
    socket.on('upvote-code', (data) => {
        const tentId = data.tentId;
        const msgId = data.msgId;
        const tent = database[tentId];
        if (!tent) return; // Tent no longer exists (shouldn't normally happen)

        const msg = tent.messages.find((m) => m.id === msgId);
        if (!msg) return; // message no longer exists

        msg.upvotes += 1;

        io.to(tentId).emit('update-upvotes', { msgId: msgId, upvotes: msg.upvotes });
    });
});

// Render (and most hosts) provide the port to bind to via process.env.PORT;
// 3000 is just a sane local-development fallback.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('Code Tent server listening on port ' + PORT);
});
