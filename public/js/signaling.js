export class SignalingClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = {};
    this.roomId = null;
    this._closed = false;
  }

  connect(maxRetries = 3) {
    return new Promise((resolve, reject) => {
      let attempt = 0;

      const tryConnect = () => {
        attempt++;
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          this._setupListeners();
          resolve();
        };

        this.ws.onerror = () => {
          // onerror is always followed by onclose, handle retry there
        };

        this.ws.onclose = () => {
          if (!this.ws._opened) {
            // Connection never opened — retry
            if (attempt < maxRetries) {
              const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
              setTimeout(tryConnect, delay);
            } else {
              reject(new Error('Could not connect to signaling server'));
            }
          }
        };
      };

      tryConnect();
    });
  }

  _setupListeners() {
    this.ws._opened = true;

    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const handler = this.handlers[msg.type];
      if (handler) handler(msg);
    };

    this.ws.onclose = () => {
      if (this._closed) return;

      // Auto-reconnect if we were in a room
      if (this.roomId) {
        this._reconnect();
      } else {
        const handler = this.handlers['close'];
        if (handler) handler();
      }
    };
  }

  async _reconnect() {
    const maxAttempts = 5;
    for (let i = 0; i < maxAttempts; i++) {
      if (this._closed) return;
      const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s, 8s, 16s
      await new Promise(r => setTimeout(r, delay));
      if (this._closed) return;

      try {
        this.ws = new WebSocket(this.url);
        await new Promise((resolve, reject) => {
          this.ws.onopen = resolve;
          this.ws.onerror = reject;
        });
        this._setupListeners();
        // Re-join room
        if (this.roomId) {
          this.send({ type: 'join', roomId: this.roomId });
        }
        return; // Success
      } catch {
        // Try again
      }
    }

    // All attempts failed
    const handler = this.handlers['close'];
    if (handler) handler();
  }

  joinRoom(roomId) {
    this.roomId = roomId;
    this.send({ type: 'join', roomId });
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  on(type, callback) {
    this.handlers[type] = callback;
  }

  close() {
    this._closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export function getSignalingUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
