import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(join(__dirname, 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// sessionId → Set of WebSocket clients (max 2 per room)
const rooms = new Map();

wss.on('connection', (ws) => {
  let currentRoom = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const { sessionId } = msg;
        if (!sessionId) return;

        if (!rooms.has(sessionId)) {
          rooms.set(sessionId, new Set());
        }
        const room = rooms.get(sessionId);

        if (room.size >= 2) {
          ws.send(JSON.stringify({ type: 'error', message: 'room-full' }));
          return;
        }

        room.add(ws);
        currentRoom = sessionId;
        ws.sessionId = sessionId;

        // If this is the 2nd peer, notify the 1st (sender) that receiver joined
        if (room.size === 2) {
          room.forEach((peer) => {
            if (peer !== ws && peer.readyState === 1) {
              peer.send(JSON.stringify({ type: 'receiver-joined' }));
            }
          });
        }

        console.log(`[${sessionId}] peer joined (${room.size}/2)`);
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        if (!currentRoom) return;
        const room = rooms.get(currentRoom);
        if (!room) return;
        room.forEach((peer) => {
          if (peer !== ws && peer.readyState === 1) {
            peer.send(JSON.stringify(msg));
          }
        });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.delete(ws);

      room.forEach((peer) => {
        if (peer.readyState === 1) {
          peer.send(JSON.stringify({ type: 'peer-disconnected' }));
        }
      });

      if (room.size === 0) {
        rooms.delete(currentRoom);
        console.log(`[${currentRoom}] room closed`);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`SEND running at http://localhost:${PORT}`);
});
