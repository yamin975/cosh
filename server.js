const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// In-memory data store for rooms
const database = {};

app.get('/', (req, res) => {
    const randomRoomId = crypto.randomBytes(4).toString('hex');
    res.redirect(`/room/${randomRoomId}`);
});

// Endpoint that the button calls to fetch a new random room ID
app.get('/api/new-room', (req, res) => {
    const randomRoomId = crypto.randomBytes(4).toString('hex');
    res.json({ roomId: randomRoomId });
});

app.get('/room/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Code Chat - Room ${roomId}</title>
        <style>
            * { box-sizing: border-box; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #121212; color: #e0e0e0; margin: 0; padding: 20px; display: flex; flex-direction: column; height: 100vh; }
            header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 15px; border-bottom: 1px solid #2d2d2d; }
            h2 { color: #4fc1ff; margin: 0; font-family: monospace; }
            .share-url { font-size: 12px; color: #858585; margin-top: 4px; }
            .header-actions { display: flex; align-items: center; gap: 15px; }
            #chat-window { flex: 1; overflow-y: auto; margin: 20px 0; display: flex; flex-direction: column; gap: 15px; padding-right: 5px; }
            .msg-card { background: #1e1e1e; border: 1px solid #333; border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 8px; position: relative; }
            .msg-meta { font-size: 11px; color: #858585; display: flex; justify-content: space-between; }
            .msg-body { font-family: 'Courier New', Courier, monospace; background: #252526; color: #d4d4d4; padding: 10px; border-radius: 4px; white-space: pre-wrap; word-break: break-all; border-left: 3px solid #007acc; }
            .msg-actions { display: flex; gap: 10px; align-items: center; }
            button { background: #2d2d2d; color: #fff; border: 1px solid #444; padding: 5px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; display: inline-flex; align-items: center; gap: 5px; }
            button:hover { background: #3d3d3d; }
            .create-room-btn { background: #333333; border-color: #555; color: #ffb74d; font-weight: 500; padding: 8px 12px; }
            .create-room-btn:hover { background: #444444; }
            .upvote-btn { border-color: #388e3c; color: #81c784; }
            .upvote-btn:hover { background: #1b5e20; }
            .copy-btn { border-color: #0288d1; color: #29b6f6; }
            .copy-btn:hover { background: #01579b; }
            .input-area { display: flex; gap: 10px; min-height: 80px; }
            textarea { flex: 1; background: #1e1e1e; color: #fff; border: 1px solid #333; border-radius: 6px; padding: 10px; font-family: monospace; resize: none; outline: none; }
            textarea:focus { border-color: #007acc; }
            .send-btn { background: #007acc; border: none; padding: 0 25px; font-weight: bold; height: auto; color: white; cursor: pointer; border-radius: 6px; }
            .send-btn:hover { background: #0062a3; }
        </style>
    </head>
    <body>
        <header>
            <div>
                <h2>Room: ${roomId}</h2>
                <div class="share-url">Share Link: <span id="urlText" style="color:#fff"></span></div>
            </div>
            <div class="header-actions">
                <button class="create-room-btn" id="createRoomBtn">➕ Create New Room</button>
                <div id="status" style="color: #6a9955; font-size: 12px;">Connected</div>
            </div>
        </header>
        
        <div id="chat-window"></div>

        <div class="input-area">
            <textarea id="codeInput" placeholder="Paste your working code snippet here... Enter to send."></textarea>
            <button class="send-btn" id="sendBtn">Share</button>
        </div>

        <script src="/socket.io/socket.io.js"></script>
        <script>
            const socket = io();
            const roomId = "${roomId}";
            const chatWindow = document.getElementById('chat-window');
            const codeInput = document.getElementById('codeInput');
            const sendBtn = document.getElementById('sendBtn');
            const createRoomBtn = document.getElementById('createRoomBtn');
            
            document.getElementById('urlText').innerText = window.location.href;

            socket.emit('join-room', roomId);

            socket.on('room-history', (messages) => {
                chatWindow.innerHTML = '';
                messages.forEach(renderMessage);
                scrollToBottom();
            });

            socket.on('new-message', (msg) => {
                renderMessage(msg);
                scrollToBottom();
            });

            socket.on('update-upvotes', ({ msgId, upvotes }) => {
                const countSpan = document.getElementById('votes-' + msgId);
                if (countSpan) countSpan.innerText = upvotes;
            });

            function sendMessage() {
                const code = codeInput.value.trim();
                if (!code) return;
                socket.emit('send-code', { roomId, code });
                codeInput.value = '';
            }

            sendBtn.addEventListener('click', sendMessage);
            codeInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                }
            });

            createRoomBtn.addEventListener('click', () => {
                fetch('/api/new-room')
                    .then(response => response.json())
                    .then(data => {
                        const newUrl = window.location.origin + '/room/' + data.roomId;
                        window.open(newUrl, '_blank');
                    })
                    .catch(err => console.error('Error spawning new room:', err));
            });

            function renderMessage(msg) {
                const existing = document.getElementById('msg-' + msg.id);
                if (existing) existing.remove();

                const localTimeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

                const card = document.createElement('div');
                card.className = 'msg-card';
                card.id = 'msg-' + msg.id;
                
                card.innerHTML = \`
                    <div class="msg-meta">
                        <span>Shared at \&nbsp;\${localTimeStr}</span>
                    </div>
                    <div class="msg-body" id="body-\${msg.id}">\${escapeHTML(msg.code)}</div>
                    <div class="msg-actions">
                        <button class="upvote-btn" onclick="upvote('\${msg.id}')">
                            👍 Worked (<span id="votes-\${msg.id}">\${msg.upvotes}</span>)
                        </button>
                        <button class="copy-btn" onclick="copyCode('\${msg.id}')">📋 Copy Code</button>
                    </div>
                \`;
                chatWindow.appendChild(card);
            }

            function upvote(msgId) {
                socket.emit('upvote-code', { roomId, msgId });
            }

            function copyCode(msgId) {
                const text = document.getElementById('body-' + msgId).innerText;
                navigator.clipboard.writeText(text).then(() => {
                    alert('Code copied to clipboard!');
                });
            }

            function scrollToBottom() {
                chatWindow.scrollTop = chatWindow.scrollHeight;
            }

            function escapeHTML(str) {
                return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
            }

            socket.on('disconnect', () => {
                document.getElementById('status').innerText = "Disconnected";
                document.getElementById('status').style.color = "#f44336";
            });
        </script>
    </body>
    </html>
    `);
});

// Setup real-time listeners for classroom sockets
io.on('connection', (socket) => {
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        if (!database[roomId]) {
            database[roomId] = {
                messages: [],
                lastActive: Date.now()
            };
        }
        socket.emit('room-history', database[roomId].messages);
    });

    socket.on('send-code', (data) => {
        const newMsg = {
            id: crypto.randomBytes(6).toString('hex'),
            code: data.code,
            timestamp: Date.now(),
            upvotes: 0
        };
        if (database[data.roomId]) {
            database[data.roomId].messages.push(newMsg);
            database[data.roomId].lastActive = Date.now();
            io.to(data.roomId).emit('new-message', newMsg);
        }
    });

    socket.on('upvote-code', (data) => {
        if (database[data.roomId]) {
            const roomMsgs = database[data.roomId].messages || [];
            const targetMsg = roomMsgs.find(m => m.id === data.msgId);
            if (targetMsg) {
                targetMsg.upvotes += 1;
                database[data.roomId].lastActive = Date.now();
                io.to(data.roomId).emit('update-upvotes', { msgId: targetMsg.id, upvotes: targetMsg.upvotes });
            }
        }
    });
});

