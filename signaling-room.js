/**
 * SignalingRoom — Cloudflare Durable Object
 *
 * Each room handles exactly two WebSocket peers (sender + receiver).
 * One Durable Object instance is created per sessionId, so both peers
 * always share the same in-memory state regardless of which Worker
 * instance handled their HTTP upgrade request.
 *
 * Message types relayed between peers:
 *   offer, answer, ice-candidate  — WebRTC signaling
 *   receiver-joined               — sent to sender when second peer connects
 *   peer-disconnected             — sent to remaining peer on close
 *   error                         — e.g. room-full
 */
export class SignalingRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = []; // max 2 WebSocket objects
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    if (this.sessions.length >= 2) {
      return new Response(
        JSON.stringify({ type: 'error', message: 'room-full' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Create a WebSocketPair: client end goes in the response, server end we keep.
    const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();

    this.handleSession(serverSocket);

    return new Response(null, {
      status: 101,
      webSocket: clientSocket,
    });
  }

  handleSession(ws) {
    ws.accept();

    const isSecondPeer = this.sessions.length === 1;
    this.sessions.push(ws);

    // Notify the sender that a receiver has joined
    if (isSecondPeer) {
      const sender = this.sessions[0];
      try {
        sender.send(JSON.stringify({ type: 'receiver-joined' }));
      } catch (_) {}
    }

    ws.addEventListener('message', (event) => {
      // Relay every message to the other peer unchanged
      for (const peer of this.sessions) {
        if (peer !== ws) {
          try {
            peer.send(event.data);
          } catch (_) {}
        }
      }
    });

    ws.addEventListener('close', () => {
      this.sessions = this.sessions.filter((s) => s !== ws);
      // Notify the remaining peer
      for (const peer of this.sessions) {
        try {
          peer.send(JSON.stringify({ type: 'peer-disconnected' }));
        } catch (_) {}
      }
    });

    ws.addEventListener('error', () => {
      this.sessions = this.sessions.filter((s) => s !== ws);
    });
  }
}
