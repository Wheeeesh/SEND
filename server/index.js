const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Static file server
const server = http.createServer((req, res) => {
  let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);

  // SPA fallback: serve index.html for unknown paths
  if (!fs.existsSync(filePath)) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// WebSocket signaling server
const wss = new WebSocketServer({ server, path: '/ws' });

// Room management: roomId -> Set<WebSocket>
const rooms = new Map();

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomId = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const { roomId } = msg;
        if (!roomId) return;

        // Check room capacity
        const room = rooms.get(roomId);
        if (room && room.size >= 2) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
          return;
        }

        // Join room
        ws.roomId = roomId;
        if (!rooms.has(roomId)) {
          rooms.set(roomId, new Set());
        }
        rooms.get(roomId).add(ws);

        // Notify peers
        if (rooms.get(roomId).size === 2) {
          for (const peer of rooms.get(roomId)) {
            peer.send(JSON.stringify({ type: 'peer-joined' }));
          }
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        // Relay to the other peer in the room
        const room = rooms.get(ws.roomId);
        if (!room) return;
        for (const peer of room) {
          if (peer !== ws && peer.readyState === 1) {
            peer.send(JSON.stringify(msg));
          }
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.roomId) {
      const room = rooms.get(ws.roomId);
      if (room) {
        room.delete(ws);
        // Notify remaining peer
        for (const peer of room) {
          peer.send(JSON.stringify({ type: 'peer-left' }));
        }
        // Clean up empty rooms
        if (room.size === 0) {
          rooms.delete(ws.roomId);
        }
      }
    }
  });
});

// Heartbeat to detect stale connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeat);
});

server.listen(PORT, () => {
  console.log(`SEND server running on http://localhost:${PORT}`);
});
