export class SignalingClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => resolve();

      this.ws.onerror = () => reject(new Error('Could not connect to signaling server'));

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
        const handler = this.handlers['close'];
        if (handler) handler();
      };
    });
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
