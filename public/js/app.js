import { initSender } from './sender.js';
import { initReceiver } from './receiver.js';

// Check browser support
if (!('RTCPeerConnection' in window) || !('WebSocket' in window)) {
  document.getElementById('unsupported').hidden = false;
} else {
  route();
}

function route() {
  const hash = window.location.hash;

  if (hash.startsWith('#/r/')) {
    const roomId = hash.slice(4);
    if (roomId) {
      document.getElementById('receiver-view').hidden = false;
      initReceiver(roomId);
      return;
    }
  }

  // Default: sender view
  document.getElementById('sender-view').hidden = false;
  initSender();
}
