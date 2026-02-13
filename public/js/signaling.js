export class SignalingClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = {};
    this._closed = false;
  }

  connect(maxRetries = 3) {
    return new Promise((resolve, reject) => {
      let attempt = 0;

      const tryConnect = () => {
        attempt++;
        const ws = new WebSocket(this.url);
        let opened = false;

        ws.onopen = () => {
          opened = true;
          this.ws = ws;
          this._setupListeners();
          resolve();
        };

        ws.onerror = () => {
          // onerror is always followed by onclose
        };

        ws.onclose = () => {
          if (!opened) {
            if (attempt < maxRetries) {
              const delay = Math.pow(2, attempt - 1) * 1000;
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
      const handler = this.handlers['close'];
      if (handler) handler();
    };
  }

  joinRoom(roomId) {
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
