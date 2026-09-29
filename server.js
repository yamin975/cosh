// =============================================================================
// CODE TENT - a realtime, temporary code-sharing chat room ("Tent")
// =============================================================================
//
// THE BIG PICTURE (read this first - it explains how all the pieces connect)
//
//   1. Someone opens the website's main address ("/").
//      The server makes a random ID (like "a1b2c3d4") and redirects them to
//      "/tent/a1b2c3d4". That page IS the Tent.
//
//   2. The server builds ONE big HTML page (as a text string) and sends it to
//      the browser. That page contains the design (CSS) and the browser-side
//      logic (JavaScript).
//
//   3. The JavaScript in the browser connects back to the server using
//      Socket.IO. Socket.IO is a library that lets the server and browsers
//      send messages to each other instantly, without reloading the page.
//
//   4. When someone pastes code and clicks "Share", their browser tells the
//      server "here is new code". The server saves it and then tells EVERY
//      browser inside that same Tent. Each browser draws a new card on screen.
//
//   5. Clicking "Worked" (upvote) works the same way: browser -> server ->
//      everyone in the Tent.
//
// Two "worlds" exist in this one file, and it is important not to mix them up:
//   - SERVER code  -> runs on Render (Node.js). Has access to crypto, the
//                     in-memory database, etc.
//   - BROWSER code -> lives inside the big HTML string below (between the
//                     <script> tags). Runs on each user's device. It can
//                     touch the page (document, buttons) but NOT the server's
//                     variables directly. They only talk through Socket.IO.
// =============================================================================


// -----------------------------------------------------------------------------
// 1) IMPORTING LIBRARIES
// "require" loads a module (a ready-made toolbox) so we can use it.
// -----------------------------------------------------------------------------

// Express: makes it easy to create a web server with routes like "/tent/abc".
const express = require('express');

// http: Node's built-in HTTP module. We need the raw HTTP server because
// Socket.IO must attach to it (Express alone is not enough for that).
const http = require('http');

// Socket.IO's server class. The curly braces { Server } mean "take only the
// piece called Server from that library" (this is called destructuring).
const { Server } = require('socket.io');

// crypto: Node's built-in module for secure random values. We use it to
// create unpredictable IDs for tents and messages.
const crypto = require('crypto');


// -----------------------------------------------------------------------------
// 2) CREATING THE SERVER
// -----------------------------------------------------------------------------

// "app" is our Express application. We attach routes (URL handlers) to it.
const app = express();

// Wrap the Express app in a plain HTTP server so Socket.IO can share it.
const server = http.createServer(app);

// Create the Socket.IO server on top of our HTTP server.
//
// transports: ['polling'] forces "long-polling" instead of WebSockets.
//   - WebSockets = one permanent connection (faster, but Render's free tier
//     proxy sometimes breaks it).
//   - Long-polling = the browser repeatedly asks "anything new?" (slightly
//     slower, but works reliably on Render's free tier).
//
// cors: controls which websites are allowed to connect. origin "*" means
//   "anyone", which is fine for a public demo but not for a private app.
const io = new Server(server, {
    transports: ['polling'],
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});


// -----------------------------------------------------------------------------
// 3) THE "DATABASE"
// -----------------------------------------------------------------------------

// A plain JavaScript object used as storage. Its shape looks like this:
//
//   database = {
//     "a1b2c3d4": {                       <- one entry per Tent (key = tentId)
//        messages: [ {id, code, timestamp, upvotes}, ... ],
//        lastActive: 1712345678901        <- time of the last activity
//     },
//     "ffee1122": { ... }
//   }
//
// IMPORTANT: this lives only in the server's memory (RAM). If the server
// restarts (or Render puts a free app to sleep), EVERYTHING here is erased.
// To keep data permanently you would need a real database (e.g. PostgreSQL).
const database = {};


// =============================================================================
// THEME ENGINE - gives every Tent its own look
// =============================================================================
//
// GOAL: each Tent should look different, but everyone INSIDE one Tent must
// see the SAME look.
//
// HOW: we turn the tent's ID text into a number (a "seed"). We feed that seed
// into a special random-number generator. A seeded generator gives the exact
// same "random" numbers every time for the same seed. So:
//     same tentId  ->  same numbers  ->  same theme  (for everyone)
//     new tentId   ->  different numbers -> different theme
//
// (If we used plain Math.random(), every page refresh would change the look,
// and two people in the same Tent would see different designs.)

// Turns any text into a 32-bit number. This is a "hash function" (FNV-1a).
// Same text always gives the same number; small changes in text give very
// different numbers.
function hashString(str) {
    let h = 2166136261;                      // starting value (a standard FNV constant)
    for (let i = 0; i < str.length; i++) {   // go through each character
        h ^= str.charCodeAt(i);              // mix the character's code into h (XOR)
        h = Math.imul(h, 16777619);          // multiply, keeping it a 32-bit integer
    }
    return h >>> 0;                          // ">>> 0" converts to an unsigned (non-negative) number
}

// mulberry32: a tiny seeded random-number generator.
// Calling mulberry32(seed) gives you back a FUNCTION. Every time you call
// that function it returns the next number between 0 and 1 in a fixed
// sequence determined by the seed.
function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        // (You do not need to understand the bit-math above. It just scrambles
        //  the numbers well. What matters is: same seed -> same sequence.)
    };
}

// The lists the theme engine chooses from. Add more items to get more variety.
const HEADING_FONTS = ['Space Grotesk', 'Sora', 'Outfit', 'Manrope', 'Plus Jakarta Sans', 'DM Sans', 'Unbounded'];
const MONO_FONTS = ['JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Space Mono', 'Roboto Mono']; // "mono" = every letter has equal width (best for code)
const PATTERNS = ['dots', 'grid', 'diagonal', 'none'];   // faint texture on the background
const BUTTON_STYLES = ['rounded', 'pill', 'sharp'];
const RADII = [6, 10, 14, 18, 24];                        // corner roundness in pixels

// Picks one random item from an array, using the seeded generator "rand".
// rand() is between 0 and 1, so rand() * length is between 0 and length;
// Math.floor rounds down to a valid index.
function pick(rand, arr) {
    return arr[Math.floor(rand() * arr.length)];
}

// Builds the complete theme (a bundle of design choices) for one Tent.
function generateTheme(tentId) {
    // Make a generator seeded from this tent's ID.
    const rand = mulberry32(hashString(tentId));

    // NOTE: the ORDER of these rand() calls matters. Each call moves the
    // generator forward, so changing the order changes every Tent's theme.
    const hue = Math.floor(rand() * 360);                     // main color on the color wheel (0-359)
    const hue2 = (hue + 30 + Math.floor(rand() * 90)) % 360;  // second color, 30-119 degrees away for contrast
    const angle = Math.floor(rand() * 360);                   // direction of the background gradient
    const sat = 55 + Math.floor(rand() * 25);                 // color intensity: 55-79%
    const accentLight = 58 + Math.floor(rand() * 14);         // brightness of accent colors: 58-71%

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

// Builds the link that asks Google Fonts to send the two chosen fonts.
// Font names with spaces must use "+" in URLs ("Space Grotesk" -> "Space+Grotesk").
// The /g in the replace means "replace ALL spaces", not just the first one.
function fontUrl(theme) {
    const h = theme.headingFont.replace(/ /g, '+');
    const m = theme.monoFont.replace(/ /g, '+');
    return `https://fonts.googleapis.com/css2?family=${h}:wght@400;600;700&family=${m}:wght@400;500&display=swap`;
}

// Converts the theme's button style word into an actual CSS corner radius.
function buttonRadiusCss(theme) {
    if (theme.buttonStyle === 'pill') return '999px';   // huge radius = fully round ends
    if (theme.buttonStyle === 'sharp') return '3px';    // almost square
    return theme.radius + 'px';                         // "rounded" reuses the card's radius
}

// Builds the optional faint background texture.
//
// It returns TWO lists: "images" (what to draw) and "sizes" (how big each
// drawing tile is). They must stay the same length, because CSS matches the
// 1st image with the 1st size, the 2nd image with the 2nd size, and so on.
//
// WHY LAYERS: an earlier version wrote a second "background-image" that
// REPLACED the dark gradient, leaving a white page. Putting everything in
// one combined list keeps the texture ON TOP of the gradient instead.
function patternLayer(theme) {
    // Very transparent (0.06 = 6% visible) so it stays a subtle texture.
    const c = `hsla(${theme.hue}, ${theme.sat}%, 65%, 0.06)`;
    switch (theme.pattern) {
        case 'dots':
            return {
                images: [`radial-gradient(${c} 1.5px, transparent 1.5px)`],
                sizes: ['22px 22px']
            };
        case 'grid':
            // A grid = horizontal lines + vertical lines = 2 layers.
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
            return { images: [], sizes: [] };   // "none": add no extra layer
    }
}


// =============================================================================
// ROUTES - what the server does for each web address (URL)
// =============================================================================
// app.get('/path', (req, res) => { ... }) means:
//   "When a browser requests /path, run this function."
//   req = the incoming request (URL details, etc.)
//   res = the response we send back

// Tent IDs are now typed in by people (not just clicked from a generated
// link), so we validate them: letters, digits, underscore, hyphen only,
// 1-32 characters long. This also closes a security gap - without this
// check, a crafted ID could break out of the quotes/tags it gets inserted
// into on the Tent page and inject arbitrary HTML/JavaScript.
function isValidTentId(id) {
    return /^[a-zA-Z0-9_-]{1,32}$/.test(id);
}

// A small standalone page shown when someone requests an invalid Tent ID
// (either typed wrong on the landing page, or a malformed/malicious link).
// Deliberately plain and self-contained - it does not depend on a theme,
// since we may not want to trust/echo back whatever bad input caused it.
function invalidTentIdPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invalid Tent ID</title>
<style>
  body { background:#121212; color:#e0e0e0; font-family: -apple-system, sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; text-align:center; padding:20px; }
  h2 { color:#ff6b6b; }
  a { color:#4fc1ff; }
</style>
</head>
<body>
  <h2>&#9978; Invalid Tent ID</h2>
  <p>Tent IDs can only contain letters, numbers, underscores, and hyphens (1-32 characters).</p>
  <p><a href="/">&larr; Back to Code Tent</a></p>
</body>
</html>`;
}

// Main address ("/"): a landing page where people can either start a brand
// new Tent, or type in the ID of an existing Tent to join it.
app.get('/', (req, res) => {
    // Reuse the theme engine with a fixed seed string, so the landing page
    // still gets a nice generated look, but the SAME look every time
    // (rather than changing on every visit, which would feel inconsistent
    // for a page that is not tied to any one Tent).
    const theme = generateTheme('__landing__');
    const pattern = patternLayer(theme);
    const gradientImage = `linear-gradient(${theme.angle}deg, var(--bg-deep), var(--bg-deep2), var(--bg-deep))`;
    const bgImages = [...pattern.images, gradientImage].join(', ');
    const bgSizes = [...pattern.sizes, '200% 200%'].join(', ');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Code Tent</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${fontUrl(theme)}" rel="stylesheet">
<style>
  :root {
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
    font-family: var(--font-head);
    color: #e8e8ea;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 20px;
    background-color: var(--bg-deep);
    background-image: ${bgImages};
    background-size: ${bgSizes};
    animation: driftBg 22s ease-in-out infinite;
  }
  @keyframes driftBg {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  .landing-card {
    width: 100%;
    max-width: 420px;
    background: rgba(255,255,255,0.035);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: var(--radius);
    padding: 32px 28px;
    backdrop-filter: blur(6px);
    text-align: center;
  }
  .landing-emoji { font-size: 40px; filter: drop-shadow(0 0 8px var(--accent-soft)); }
  h1 {
    font-family: var(--font-mono);
    color: var(--accent);
    font-size: 26px;
    margin: 10px 0 4px;
  }
  .tagline { color: #9a9aa2; font-size: 13px; margin: 0 0 26px; }
  .divider { display: flex; align-items: center; gap: 10px; margin: 22px 0; color: #6b6b73; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: rgba(255,255,255,0.1); }
  input {
    width: 100%;
    background: rgba(255,255,255,0.04);
    color: #fff;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: var(--radius);
    padding: 12px 14px;
    font-family: var(--font-mono);
    font-size: 14px;
    outline: none;
    text-align: center;
    letter-spacing: 0.5px;
    transition: border-color 0.15s ease;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  input::placeholder { color: #7c7c86; letter-spacing: normal; }
  button {
    width: 100%;
    margin-top: 10px;
    background: rgba(255,255,255,0.04);
    color: #f0f0f2;
    border: 1px solid var(--accent-soft);
    padding: 12px;
    border-radius: var(--btn-radius);
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    font-family: var(--font-head);
    transition: transform 0.12s ease, background 0.15s ease, border-color 0.15s ease;
  }
  button:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateY(-1px); }
  button:active { transform: translateY(0); }
  .create-btn {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #111;
    border: none;
    font-weight: 700;
  }
  .create-btn:hover { filter: brightness(1.08); }
  .error-text { color: #ff8080; font-size: 12px; margin: 8px 0 0; min-height: 14px; }
</style>
</head>
<body>
  <div class="landing-card">
    <div class="landing-emoji">&#9978;</div>
    <h1>Code Tent</h1>
    <p class="tagline">Realtime code sharing, one link at a time.</p>

    <button class="create-btn" id="createBtn">+ Start a New Tent</button>

    <div class="divider">or</div>

    <input id="joinInput" type="text" placeholder="Enter Tent ID" maxlength="32" autocomplete="off" autocapitalize="off" spellcheck="false">
    <button id="joinBtn">Join Tent</button>
    <p class="error-text" id="errorText"></p>
  </div>

  <script>
    const createBtn = document.getElementById('createBtn');
    const joinBtn = document.getElementById('joinBtn');
    const joinInput = document.getElementById('joinInput');
    const errorText = document.getElementById('errorText');

    // Same character rule as the server (letters, digits, underscore,
    // hyphen). Checking it here too just gives instant feedback without
    // waiting on a round trip - the server re-checks it regardless.
    const VALID_ID = /^[a-zA-Z0-9_-]{1,32}$/;

    createBtn.addEventListener('click', function () {
      fetch('/api/new-tent')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          window.location.href = '/tent/' + data.tentId;
        });
    });

    function joinTent() {
      const id = joinInput.value.trim();
      if (!id) {
        errorText.textContent = 'Enter a Tent ID first.';
        return;
      }
      if (!VALID_ID.test(id)) {
        errorText.textContent = 'Only letters, numbers, - and _ are allowed.';
        return;
      }
      window.location.href = '/tent/' + id;
    }

    joinBtn.addEventListener('click', joinTent);
    joinInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') joinTent();
    });
  </script>
</body>
</html>`;

    res.send(html);
});

// Used by the "+New Tent" button. The browser calls this to get a fresh ID,
// then opens it in a new tab. It returns JSON (data), not a web page.
app.get('/api/new-tent', (req, res) => {
    const randomTentId = crypto.randomBytes(4).toString('hex');
    res.json({ tentId: randomTentId });
});

// Old links used "/room/..." before we renamed Room -> Tent. This forwards
// them to the new address so old bookmarks do not show "Cannot GET".
app.get('/room/:tentId', (req, res) => {
    res.redirect('/tent/' + req.params.tentId);
});

// THE MAIN PAGE. ":tentId" in the path is a placeholder - whatever text is in
// that spot of the URL becomes available as req.params.tentId.
// Example: visiting /tent/abc123 makes req.params.tentId equal "abc123".
app.get('/tent/:tentId', (req, res) => {
    const tentId = req.params.tentId;

    // Reject anything that is not a plain, expected-shape ID BEFORE it gets
    // anywhere near the page template. This is what actually makes typed-in
    // Tent IDs safe: no matter what someone enters (or links to), only
    // letters/digits/underscore/hyphen can ever reach the HTML below.
    if (!isValidTentId(tentId)) {
        return res.status(400).send(invalidTentIdPage());
    }

    // Work out this Tent's look (same ID -> same result every time).
    const theme = generateTheme(tentId);

    // Combine the texture layer(s) and the main gradient into ONE list each.
    // The "..." (spread) copies every item of an array into a new array.
    // Texture goes first because the FIRST image is drawn on TOP.
    const pattern = patternLayer(theme);
    const gradientImage = `linear-gradient(${theme.angle}deg, var(--bg-deep), var(--bg-deep2), var(--bg-deep))`;
    const bgImages = [...pattern.images, gradientImage].join(', ');
    const bgSizes = [...pattern.sizes, '200% 200%'].join(', ');   // 200% makes the gradient larger than the screen so it can slowly drift

    // The whole web page as one text string. It is written between BACKTICKS
    // (`...`), which are "template literals": they allow multiple lines and
    // let us insert values using dollar-sign + curly braces around a variable
    // name (for example, the tent ID or a theme value gets dropped in there).
    //
    // RULE for anything inside the backticks: never type a backtick or a
    // dollar-curly sequence by accident in comments/code, or JavaScript will
    // treat it as part of the template and break.
    const html = `<!DOCTYPE html>
<html lang="en" data-theme-pattern="${theme.pattern}">
<head>
<!-- charset: lets the page show all characters and emojis correctly. -->
<meta charset="UTF-8">
<!-- viewport: makes the page scale properly on phones. -->
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- The text shown on the browser tab. -->
<title>Cosh Tent - ${tentId}</title>
<!-- preconnect: tells the browser to open the connection to Google Fonts early so fonts load faster. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<!-- Loads this Tent's two fonts. -->
<link href="${fontUrl(theme)}" rel="stylesheet">
<style>
  /* ---------------- THEME VARIABLES ----------------
     CSS variables (names starting with two dashes) are values defined once
     and reused everywhere with var(--name). The server fills these in with
     THIS Tent's generated theme, so every rule below automatically follows
     the theme. */
  :root {
    --hue: ${theme.hue};
    --hue2: ${theme.hue2};
    --sat: ${theme.sat}%;
    --accent: hsl(${theme.hue}, ${theme.sat}%, ${theme.accentLight}%);        /* main accent color */
    --accent2: hsl(${theme.hue2}, ${theme.sat}%, ${theme.accentLight}%);      /* second accent color */
    --accent-soft: hsla(${theme.hue}, ${theme.sat}%, ${theme.accentLight}%, 0.15); /* faint version (15% visible) for borders/hover */
    --bg-deep: hsl(${theme.hue}, 35%, 6%);    /* very dark background (only 6% light) */
    --bg-deep2: hsl(${theme.hue2}, 30%, 9%);  /* second dark background tone */
    --radius: ${theme.radius}px;              /* corner roundness of cards and inputs */
    --btn-radius: ${buttonRadiusCss(theme)};  /* corner roundness of buttons */
    --font-head: '${theme.headingFont}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; /* fallbacks if the font fails to load */
    --font-mono: '${theme.monoFont}', 'Courier New', monospace;
  }

  /* border-box: padding and border are counted INSIDE an element's width,
     which makes sizing much more predictable. Applied to everything (*). */
  * { box-sizing: border-box; }

  html, body { height: 100%; }

  /* ---------------- PAGE BACKGROUND + LAYOUT ---------------- */
  body {
    margin: 0;
    padding: 20px;
    font-family: var(--font-head);
    color: #e8e8ea;                 /* light text on dark background */
    display: flex;                  /* flexbox: arranges children in a row or column */
    flex-direction: column;         /* stack header, chat, and input vertically */
    min-height: 100vh;              /* at least the full screen height (vh = viewport height) */
    /* Solid dark fallback color so the page is never white, even for a
       split second before the gradient paints. */
    background-color: var(--bg-deep);
    /* The layered background built on the server (texture on top of gradient). */
    background-image: ${bgImages};
    background-size: ${bgSizes};
    /* Run the "driftBg" animation forever, taking 22 seconds per cycle. */
    animation: driftBg 22s ease-in-out infinite;
  }

  /* Slowly slides the oversized gradient left and right so the background
     seems to gently shift colors. */
  @keyframes driftBg {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }

  /* ---------------- HEADER (tent name, buttons, status) ---------------- */
  header {
    display: flex;
    justify-content: space-between;   /* title on the left, buttons on the right */
    align-items: center;              /* vertically center both sides */
    flex-wrap: wrap;                  /* on narrow screens, wrap onto a new line */
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
  .tent-emoji { font-size: 22px; filter: drop-shadow(0 0 6px var(--accent-soft)); } /* soft glow around the tent emoji */
  .share-url { font-size: 12px; color: #9a9aa2; margin-top: 4px; word-break: break-all; }
  .header-actions { display: flex; align-items: center; gap: 12px; }

  /* Connection status text plus a small colored dot drawn with ::before
     (a pseudo-element: an extra decoration created purely by CSS).
     Green by default; the browser JS adds the "disconnected" class to make
     it red when the connection to the server is lost. */
  #status { font-size: 12px; color: #6adf8f; display: flex; align-items: center; gap: 6px; }
  #status::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #6adf8f; box-shadow: 0 0 6px #6adf8f; }
  #status.disconnected { color: #f45f5f; }
  #status.disconnected::before { background: #f45f5f; box-shadow: 0 0 6px #f45f5f; }

  /* ---------------- BUTTONS ---------------- */
  /* Default style for EVERY button; specific buttons below override parts. */
  button {
    background: rgba(255,255,255,0.04);   /* rgba = color + transparency; barely visible white */
    color: #f0f0f2;
    border: 1px solid var(--accent-soft);
    padding: 8px 14px;
    border-radius: var(--btn-radius);      /* shape comes from the theme */
    cursor: pointer;                       /* hand cursor on hover */
    font-size: 13px;
    font-family: var(--font-head);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: transform 0.12s ease, background 0.15s ease, border-color 0.15s ease; /* smooth hover changes */
  }
  button:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateY(-1px); } /* lifts 1px on hover */
  button:active { transform: translateY(0); }                                                              /* presses back down on click */

  .new-tent-btn { color: var(--accent2); border-color: var(--accent2); }

  /* Styled to match the other header buttons even though it is a plain
     <a> link, not a <button> element (so it needs its own box/border/etc
     instead of inheriting the shared "button {...}" rule above). */
  .home-link {
    color: #c9c9d1;
    border: 1px solid var(--accent-soft);
    padding: 8px 14px;
    border-radius: var(--btn-radius);
    font-size: 13px;
    font-family: var(--font-head);
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: transform 0.12s ease, background 0.15s ease, border-color 0.15s ease;
  }
  .home-link:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateY(-1px); }

  /* ---------------- CHAT AREA ---------------- */
  /* The scrollable list where message cards appear. */
  #chat-window {
    flex: 1;                 /* take all leftover vertical space between header and input */
    overflow-y: auto;        /* show a vertical scrollbar only when content is too tall */
    margin: 20px 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-right: 6px;
  }
  #chat-window::-webkit-scrollbar { width: 8px; }
  #chat-window::-webkit-scrollbar-thumb { background: var(--accent-soft); border-radius: 8px; } /* themed scrollbar (Chrome/Safari) */

  /* One shared code snippet = one "glass" card. */
  .msg-card {
    background: rgba(255,255,255,0.035);
    border: 1px solid rgba(255,255,255,0.08);
    border-left: 3px solid var(--accent);   /* thicker colored stripe on the left edge */
    border-radius: var(--radius);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    backdrop-filter: blur(6px);             /* blurs whatever is behind the card (frosted glass) */
    /* Two animations run together on arrival: cardEnter (slide/scale/fade
       in) and cardGlow (a soft accent-colored ring that blooms outward and
       fades) - together this reads as "new message just landed", not just
       a plain fade. */
    animation: cardEnter 0.45s cubic-bezier(0.16, 1, 0.3, 1),
               cardGlow 1.1s ease-out;
  }
  @keyframes cardEnter {
    0%   { opacity: 0; transform: translateY(14px) scale(0.97); }
    100% { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes cardGlow {
    0%   { box-shadow: 0 0 0 0 var(--accent-soft), 0 0 0 0 rgba(0,0,0,0); }
    35%  { box-shadow: 0 0 0 3px var(--accent-soft), 0 0 24px 2px var(--accent-soft); }
    100% { box-shadow: 0 0 0 0 rgba(0,0,0,0), 0 0 0 0 rgba(0,0,0,0); }
  }
  .msg-meta { font-size: 11px; color: #8f8f98; display: flex; justify-content: space-between; }

  /* The box that actually shows the pasted code. */
  .msg-body {
    font-family: var(--font-mono);
    background: rgba(0,0,0,0.35);
    color: #e2e2e6;
    padding: 12px;
    border-radius: calc(var(--radius) - 4px);
    white-space: pre-wrap;    /* KEEP the user's line breaks and indentation, but still wrap long lines */
    word-break: break-word;   /* break very long words instead of overflowing the card */
    font-size: 13px;
    line-height: 1.5;
  }
  .msg-actions { display: flex; gap: 10px; align-items: center; }
  .upvote-btn { border-color: rgba(120,200,140,0.4); color: #a3e6b5; }   /* green: "this worked" */
  .upvote-btn:hover { background: rgba(120,200,140,0.15); }
  .copy-btn { border-color: rgba(120,170,220,0.4); color: #a9cdf0; }     /* blue: copy */
  .copy-btn:hover { background: rgba(120,170,220,0.15); }

  /* Momentary "copied" state: the button flips to a green checkmark and
     briefly pops in size, then settles back to normal before reverting to
     its default label (handled by adding/removing this class in JS). */
  .copy-btn.copied {
    color: #a3e6b5;
    border-color: rgba(120,200,140,0.6);
    background: rgba(120,200,140,0.18);
    animation: copyPop 0.4s ease;
  }
  @keyframes copyPop {
    0%   { transform: scale(1); }
    40%  { transform: scale(1.12); }
    100% { transform: scale(1); }
  }

  /* Small muted "Copied by N" note that sits next to the Copy button.
     Empty (and so invisible, taking no space) until at least one person
     has copied the snippet. Fades in smoothly whenever its text changes
     because the browser re-paints it - no extra animation needed here. */
  .copy-count {
    font-size: 11px;
    color: #8f8f98;
    font-style: italic;
  }

  /* ---------------- TOAST NOTIFICATION ----------------
     A small confirmation pill that slides up from the bottom, pauses, then
     fades back out. Reused for "Copied to clipboard" (and could be reused
     for any future confirmation). Fixed positioning takes it out of the
     normal page flow so it floats above everything else. */
  #toast {
    position: fixed;
    left: 50%;
    bottom: 28px;
    transform: translate(-50%, 16px);
    background: rgba(20,20,24,0.92);
    color: #f0f0f2;
    border: 1px solid var(--accent-soft);
    padding: 10px 18px;
    border-radius: var(--btn-radius);
    font-size: 13px;
    font-family: var(--font-head);
    display: flex;
    align-items: center;
    gap: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    opacity: 0;
    pointer-events: none;         /* never blocks clicks, even while visible */
    z-index: 50;
    transition: opacity 0.25s ease, transform 0.25s ease;
  }
  #toast.show {
    opacity: 1;
    transform: translate(-50%, 0);
  }
  #toast .toast-check {
    color: #7be29a;
    font-weight: 700;
  }

  /* ---------------- INPUT BAR (bottom) ---------------- */
  .input-area { display: flex; gap: 10px; min-height: 84px; }
  textarea {
    flex: 1;                          /* textarea takes all width the Share button does not need */
    background: rgba(255,255,255,0.04);
    color: #fff;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: var(--radius);
    padding: 12px;
    font-family: var(--font-mono);
    font-size: 13px;
    resize: none;                     /* hide the drag-to-resize handle */
    outline: none;                    /* remove the browser's default focus outline (we add our own below) */
    transition: border-color 0.15s ease;
  }
  /* When the user clicks into the box: accent border plus a soft glow ring. */
  textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  textarea::placeholder { color: #7c7c86; }   /* color of the "Your Code" hint text */

  /* The Share button: a FIXED red-to-black gradient. It deliberately does not
     use theme colors, so it looks identical in every Tent. */
  .send-btn {
    background: linear-gradient(135deg, #ff3b3b 0%, #8a0000 55%, #1a0000 100%);
    border: 1px solid rgba(255,80,80,0.5);
    padding: 0 26px;
    font-weight: 700;
    color: #fff;
    font-size: 14px;
    text-shadow: 0 1px 2px rgba(0,0,0,0.5);
    box-shadow: 0 4px 14px rgba(180,0,0,0.35);   /* red glow under the button */
  }
  .send-btn:hover {
    filter: brightness(1.12);                    /* slightly brighter on hover */
    transform: translateY(-1px);
    box-shadow: 0 6px 18px rgba(180,0,0,0.5);
  }
  .send-btn:active { transform: translateY(0); filter: brightness(0.95); }

  /* Added briefly (via JS, then removed) right when a message is sent - a
     quick outward ring burst confirming the click registered, independent
     of the card animation that plays a moment later once the server
     replies. */
  .send-btn.sent-pulse { animation: sentPulse 0.35s ease; }
  @keyframes sentPulse {
    0%   { box-shadow: 0 4px 14px rgba(180,0,0,0.35), 0 0 0 0 rgba(255,80,80,0.55); }
    60%  { box-shadow: 0 4px 14px rgba(180,0,0,0.35), 0 0 0 10px rgba(255,80,80,0); }
    100% { box-shadow: 0 4px 14px rgba(180,0,0,0.35), 0 0 0 0 rgba(255,80,80,0); }
  }

  /* ---------------- MOBILE LAYOUT ----------------
     A media query applies rules only when a condition is true - here, when
     the screen is 640px wide or narrower (phones). Instead of the textarea
     and Share button sitting side by side, they stack vertically. */
  @media (max-width: 640px) {
    body { padding: 12px; }
    .input-area { flex-direction: column; min-height: auto; }
    .send-btn { padding: 12px; }
  }
</style>
</head>
<body>
  <!-- ================= HEADER ================= -->
  <header>
    <div class="tent-title">
      <span class="tent-emoji">&#9978;</span>   <!-- &#9978; is the HTML code for the tent emoji -->
      <div>
        <h2>Tent: ${tentId}</h2>
        <!-- The span below is empty on purpose; the browser JS fills it with the real page address. -->
        <div class="share-url">Share Link: <span id="urlText"></span></div>
      </div>
    </div>
    <div class="header-actions">
      <a class="home-link" href="/" title="Create or join another Tent">&#8962; Tents</a>
      <button class="new-tent-btn" id="newTentBtn">+New Tent</button>
      <!-- Text and color of this element change when the connection drops. -->
      <div id="status">Connected</div>
    </div>
  </header>

  <!-- ================= MESSAGE LIST (starts empty; JS adds cards) ================= -->
  <div id="chat-window"></div>

  <!-- ================= INPUT BAR ================= -->
  <div class="input-area">
    <textarea id="codeInput" placeholder="Your Code"></textarea>
    <button class="send-btn" id="sendBtn">Share</button>
  </div>

  <!-- Floating confirmation pill, hidden by default (shown via the .show
       class in JS). Empty now; JS fills it in each time it is used. -->
  <div id="toast"></div>

  <!-- This file is served automatically by the Socket.IO server. It gives the
       browser the "io" function used below to connect. -->
  <script src="/socket.io/socket.io.js"></script>

  <script>
    // =========================================================================
    // BROWSER-SIDE CODE - runs on each user's device, NOT on the server.
    // =========================================================================

    // Connect to the server. The transports option must match the server's
    // (polling only), otherwise the connection can fail on Render.
    const socket = io({ transports: ['polling'] });

    // The server pasted this Tent's ID directly into the page text, so the
    // browser always knows which Tent it belongs to.
    const tentId = "${tentId}";

    // Grab references to page elements once (by their id) so we can use
    // them later without searching the page again and again.
    const chatWindow = document.getElementById('chat-window');
    const codeInput = document.getElementById('codeInput');
    const sendBtn = document.getElementById('sendBtn');
    const newTentBtn = document.getElementById('newTentBtn');
    const statusEl = document.getElementById('status');
    const toastEl = document.getElementById('toast');

    // Shows a small pill at the bottom of the screen for a moment, then
    // fades it out. "message" is the text, "icon" is an optional small
    // symbol shown before it (defaults to a checkmark).
    // A timer id is stored on the element itself (toastEl._hideTimer) so
    // that if showToast() is called again quickly, we clear the previous
    // hide timer instead of letting two calls fight over when to hide it.
    function showToast(message, icon) {
      toastEl.innerHTML = '';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'toast-check';
      iconSpan.textContent = icon || '\u{2713}';   // checkmark by default
      const textSpan = document.createElement('span');
      textSpan.textContent = message;
      toastEl.appendChild(iconSpan);
      toastEl.appendChild(textSpan);

      toastEl.classList.add('show');
      if (toastEl._hideTimer) clearTimeout(toastEl._hideTimer);
      toastEl._hideTimer = setTimeout(function () {
        toastEl.classList.remove('show');
      }, 1600);
    }

    // Show the real page address in the "Share Link" spot. Using
    // window.location.href means it is always correct (http vs https, domain).
    // textContent (not innerHTML) treats the value as plain text.
    document.getElementById('urlText').textContent = window.location.href;

    // Tell the server: "Put me in this Tent." The server replies with the
    // saved messages (handled by the 'tent-history' listener below).
    socket.emit('join-tent', tentId);

    // ---------------------- LISTENING FOR SERVER EVENTS ----------------------
    // socket.on('event-name', function) = "when the server sends this event,
    // run this function". socket.emit(...) is the opposite: we SEND an event.

    // Arrives once after joining: the full list of earlier messages.
    socket.on('tent-history', function (messages) {
      chatWindow.innerHTML = '';          // clear anything already displayed
      messages.forEach(renderMessage);    // draw one card per saved message
      scrollToBottom();
    });

    // Arrives every time ANYONE in this Tent shares code (including you).
    socket.on('new-message', function (msg) {
      renderMessage(msg);
      scrollToBottom();
    });

    // Arrives when someone upvotes. We only update the number, not the card.
    socket.on('update-upvotes', function (data) {
      const countSpan = document.getElementById('votes-' + data.msgId);
      if (countSpan) countSpan.textContent = data.upvotes;   // the "if" guards against a card that is not on screen
    });

    // Arrives when someone (anyone, on any device) copies this snippet.
    // Updates the small "Copied by N" note next to the Copy button.
    socket.on('update-copies', function (data) {
      const copyCountEl = document.getElementById('copies-' + data.msgId);
      if (copyCountEl) updateCopyCountText(copyCountEl, data.copies);
    });

    // Built-in Socket.IO events fired automatically when the connection
    // starts or drops. We use them to switch the status dot green or red.
    socket.on('connect', function () {
      statusEl.textContent = 'Connected';
      statusEl.classList.remove('disconnected');
    });
    socket.on('disconnect', function () {
      statusEl.textContent = 'Disconnected';
      statusEl.classList.add('disconnected');
    });

    // ---------------------- SENDING CODE ----------------------
    function sendMessage() {
      const code = codeInput.value.trim();   // trim() removes spaces/newlines at both ends
      if (!code) return;                     // empty box -> do nothing
      // Send the code to the server (it will broadcast it back to everyone).
      socket.emit('send-code', { tentId: tentId, code: code });
      codeInput.value = '';                  // clear the box for the next snippet

      // Quick tactile "sent" pulse on the button itself: add the class,
      // then remove it after the animation's duration so it can replay on
      // the very next click (CSS animations do not restart while a class
      // is already applied).
      sendBtn.classList.add('sent-pulse');
      setTimeout(function () { sendBtn.classList.remove('sent-pulse'); }, 350);
    }

    // Clicking "Share" sends the message.
    sendBtn.addEventListener('click', sendMessage);

    // Pressing Enter sends; Shift+Enter inserts a normal new line, which is
    // needed for typing multi-line code. preventDefault() stops the browser's
    // normal Enter behavior (adding a new line) when we want to send instead.
    codeInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // "+New Tent": ask the server for a new ID, then open it in a new tab.
    // fetch() makes a request; .then() runs when the response arrives.
    // The first .then converts the reply to JSON, the second uses that data.
    newTentBtn.addEventListener('click', function () {
      fetch('/api/new-tent')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          window.open('/tent/' + data.tentId, '_blank');   // _blank = new tab
        });
    });

    // ---------------------- DRAWING ONE MESSAGE CARD ----------------------
    // Builds the card using createElement + textContent instead of pasting
    // HTML text together. This matters for SAFETY: if someone pastes text
    // like a script tag, textContent shows it as harmless plain text instead
    // of running it (this prevents an attack called XSS).
    function renderMessage(msg) {
      // If a card with this ID already exists, remove it first so we never
      // show the same message twice.
      const existing = document.getElementById('msg-' + msg.id);
      if (existing) existing.remove();

      // Convert the saved timestamp (milliseconds) into a readable time
      // in the viewer's own timezone, like 02:35:10 PM.
      const localTimeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      // The card (outer box).
      const card = document.createElement('div');
      card.className = 'msg-card';
      card.id = 'msg-' + msg.id;   // unique id so we can find this card later

      // Top line: "Shared at ...".
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      const metaSpan = document.createElement('span');
      metaSpan.textContent = 'Shared at ' + localTimeStr;
      meta.appendChild(metaSpan);

      // The code itself.
      const body = document.createElement('div');
      body.className = 'msg-body';
      body.id = 'body-' + msg.id;      // used by the Copy button to find the text
      body.textContent = msg.code;

      // Row holding the two buttons.
      const actions = document.createElement('div');
      actions.className = 'msg-actions';

      // "Worked" button. It contains a small <span> with the vote number so
      // that later updates can change just the number (see 'update-upvotes').
      // The \u{1F44D} is the thumbs-up emoji. The server converts that
      // escape into the real emoji before sending the page.
      const upvoteBtn = document.createElement('button');
      upvoteBtn.className = 'upvote-btn';
      const voteCount = document.createElement('span');
      voteCount.id = 'votes-' + msg.id;
      voteCount.textContent = msg.upvotes;
      upvoteBtn.textContent = '\u{1F44D} Worked (';
      upvoteBtn.appendChild(voteCount);
      upvoteBtn.appendChild(document.createTextNode(')'));
      upvoteBtn.addEventListener('click', function () { upvote(msg.id); });

      // "Copy Code" button (\u{1F4CB} is the clipboard emoji). We pass the
      // button itself (not just the id) into copyCode so it can animate
      // that exact button without having to search the page for it again.
      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = '\u{1F4CB} Copy Code';
      copyBtn.addEventListener('click', function () { copyCode(msg.id, copyBtn); });

      // Small muted note showing how many different people have copied this
      // snippet so far, e.g. "Copied by 3". Kept as its OWN element (rather
      // than inside copyBtn) so it is unaffected when the button's own label
      // briefly changes to "Copied!" after a click.
      const copyCountEl = document.createElement('span');
      copyCountEl.className = 'copy-count';
      copyCountEl.id = 'copies-' + msg.id;
      updateCopyCountText(copyCountEl, msg.copies || 0);

      // Assemble the pieces like Lego: buttons -> actions row -> card -> page.
      actions.appendChild(upvoteBtn);
      actions.appendChild(copyBtn);
      actions.appendChild(copyCountEl);

      card.appendChild(meta);
      card.appendChild(body);
      card.appendChild(actions);
      chatWindow.appendChild(card);   // finally put the card on screen
    }

    // Fills in the "Copied by N" note. Shows nothing at all when the count
    // is zero (no one has copied it yet), so freshly-shared snippets do not
    // show a slightly odd "Copied by 0".
    function updateCopyCountText(el, count) {
      el.textContent = count > 0 ? ('Copied by ' + count) : '';
    }

    // ---------------------- BUTTON ACTIONS ----------------------

    // Tell the server this message worked. We do not change the number
    // ourselves; the server counts it and broadcasts the new total to
    // everyone (so all screens always agree).
    function upvote(msgId) {
      socket.emit('upvote-code', { tentId: tentId, msgId: msgId });
    }

    // Read the code text from the card and copy it to the clipboard, then
    // give two layers of feedback: the button itself morphs into a green
    // checkmark for a moment (so the person who clicked sees it instantly,
    // even without looking away from their cursor), and a toast pill
    // confirms it at the bottom of the screen. Both revert automatically.
    //
    // "btnEl" is the actual <button> element that was clicked, passed in
    // above so we do not need to search the page for it again.
    function copyCode(msgId, btnEl) {
      const el = document.getElementById('body-' + msgId);
      const text = el.textContent;

      // writeText() returns a promise; .then() runs once the copy actually
      // succeeds, which is the right moment to show a "success" animation
      // rather than assuming it worked the instant we asked for it.
      navigator.clipboard.writeText(text).then(function () {
        if (btnEl) {
          const originalLabel = btnEl.textContent;
          btnEl.textContent = '\u{2705} Copied!';
          btnEl.classList.add('copied');

          // If this same button is clicked again quickly, cancel the
          // pending "revert" from the previous click so they do not race
          // each other and leave the button stuck on the wrong label.
          if (btnEl._revertTimer) clearTimeout(btnEl._revertTimer);
          btnEl._revertTimer = setTimeout(function () {
            btnEl.textContent = originalLabel;
            btnEl.classList.remove('copied');
          }, 1300);
        }
        showToast('Copied to clipboard');

        // Tell the server this browser copied this snippet, so it can add
        // us to the "who has copied this" count and broadcast the new
        // total to everyone in the Tent (including us - the 'update-copies'
        // listener above will then fill in the actual number).
        socket.emit('copy-code', { tentId: tentId, msgId: msgId });
      });
    }


    // Jump to the newest message. scrollHeight = total content height, so
    // setting scrollTop to it scrolls all the way down.
    function scrollToBottom() {
      chatWindow.scrollTop = chatWindow.scrollHeight;
    }
  </script>
</body>
</html>`;

    // Send the finished page to the browser.
    res.send(html);
});


// =============================================================================
// SOCKET.IO EVENT HANDLERS (SERVER SIDE)
// =============================================================================
// These respond to events the browsers send us with socket.emit(...).
//
// Two ways to send from the server:
//   socket.emit(...)     -> reply to ONLY the one browser that sent the event
//   io.to(tentId).emit() -> send to EVERYONE inside that Tent

// Runs once for every new browser that connects. "socket" represents that
// one browser's connection, so all handlers for it go inside this function.
io.on('connection', (socket) => {

    // Browser says: "I want to join this Tent."
    socket.on('join-tent', (tentId) => {
        // A Socket.IO "room" is a group of connections. Joining the group
        // named after the tentId lets us later message only that Tent.
        socket.join(tentId);

        // First visit to this Tent? Create its storage.
        if (!database[tentId]) {
            database[tentId] = {
                messages: [],
                lastActive: Date.now()   // Date.now() = current time in milliseconds
            };
        }

        // Send the saved history to JUST this browser.
        socket.emit('tent-history', database[tentId].messages);
    });

    // Browser says: "Here is a new code snippet."
    socket.on('send-code', (data) => {
        const tentId = data.tentId;

        // Safety net: create the Tent's storage if it somehow does not exist.
        if (!database[tentId]) {
            database[tentId] = { messages: [], lastActive: Date.now() };
        }

        // Build the message object that will be stored and shown.
        const newMsg = {
            id: crypto.randomBytes(6).toString('hex'),   // unique ID (used by the browser to find this card)
            code: data.code,
            timestamp: Date.now(),
            upvotes: 0,
            copies: 0            // how many DIFFERENT users have copied this snippet so far
        };

        // Save it, then remember the Tent was just used.
        database[tentId].messages.push(newMsg);
        database[tentId].lastActive = Date.now();

        // Broadcast to everyone in the Tent, including the sender. Sending it
        // back to the sender too means every person sees the exact same thing.
        io.to(tentId).emit('new-message', newMsg);
    });

    // Browser says: "This snippet worked!"
    socket.on('upvote-code', (data) => {
        const tentId = data.tentId;
        const msgId = data.msgId;

        const tent = database[tentId];
        if (!tent) return;   // unknown Tent -> ignore

        // find() returns the first message whose id matches, or undefined.
        const msg = tent.messages.find((m) => m.id === msgId);
        if (!msg) return;    // unknown message -> ignore

        msg.upvotes += 1;    // add one vote

        // Tell everyone the new total.
        io.to(tentId).emit('update-upvotes', { msgId: msgId, upvotes: msg.upvotes });
    });

    // Browser says: "I just copied this snippet to my clipboard."
    //
    // We count UNIQUE users, not raw clicks - copying the same snippet
    // three times in a row should not inflate the number three times. We
    // track who already counted using each socket's own connection id
    // (socket.id), a value Socket.IO assigns automatically and uniquely to
    // every connected browser tab. That tracking lives on the Tent object
    // itself (tent.copiedBy), NOT inside the message, so it never gets sent
    // to browsers - it is purely server-side bookkeeping.
    socket.on('copy-code', (data) => {
        const tentId = data.tentId;
        const msgId = data.msgId;

        const tent = database[tentId];
        if (!tent) return;

        const msg = tent.messages.find((m) => m.id === msgId);
        if (!msg) return;

        // copiedBy: { [msgId]: Set of socket ids that already copied it }
        // Created lazily the first time any copy happens in this Tent.
        if (!tent.copiedBy) tent.copiedBy = {};
        if (!tent.copiedBy[msgId]) tent.copiedBy[msgId] = new Set();

        // Same browser tab copying again? Do not count it twice.
        if (tent.copiedBy[msgId].has(socket.id)) return;
        tent.copiedBy[msgId].add(socket.id);

        msg.copies += 1;

        io.to(tentId).emit('update-copies', { msgId: msgId, copies: msg.copies });
    });
});


// =============================================================================
// START THE SERVER
// =============================================================================
// Hosts like Render tell the app which port to use through an environment
// variable (process.env.PORT). The "|| 3000" means: if none is provided
// (for example, on your own computer), use 3000 instead.
const PORT = process.env.PORT || 3000;

// Start listening for visitors. The function runs once the server is ready.
server.listen(PORT, () => {
    console.log('Code Tent server listening on port ' + PORT);
});
