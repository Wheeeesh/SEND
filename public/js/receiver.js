import { SignalingClient, getSignalingUrl } from './signaling.js';
import { PeerConnection } from './peer.js';
import { formatBytes, formatSpeed, formatTime } from './utils.js';

export function initReceiver(roomId) {
  const receiverConnecting = document.getElementById('receiver-connecting');
  const receiverReceiving = document.getElementById('receiver-receiving');
  const receiverComplete = document.getElementById('receiver-complete');
  const receiverError = document.getElementById('receiver-error');
  const receiverErrorMsg = document.getElementById('receiver-error-msg');

  let signaling = null;
  let peer = null;

  function showState(el) {
    [receiverConnecting, receiverReceiving, receiverComplete, receiverError].forEach(
      s => s.hidden = true
    );
    el.hidden = false;
  }

  function showError(msg) {
    receiverErrorMsg.textContent = msg;
    showState(receiverError);
    cleanup();
  }

  function cleanup() {
    if (peer) { peer.close(); peer = null; }
    if (signaling) { signaling.close(); signaling = null; }
  }

  async function connect() {
    try {
      signaling = new SignalingClient(getSignalingUrl());
      await signaling.connect();
      signaling.joinRoom(roomId);
    } catch {
      showError('Could not connect to server. Please try again.');
      return;
    }

    signaling.on('error', (msg) => {
      showError(msg.message || 'Connection error');
    });

    signaling.on('peer-left', () => {
      showError('Sender disconnected. Transfer cancelled.');
    });

    signaling.on('close', () => {
      if (!peer) {
        showError('Lost connection to server.');
      }
    });

    // Wait for offer from sender
    signaling.on('offer', async (msg) => {
      peer = new PeerConnection(signaling);

      peer.onConnectionStateChange = (state) => {
        if (state === 'failed' || state === 'disconnected') {
          showError('Connection to sender lost.');
        }
      };

      // Listen for data channels
      let fileMeta = null;
      const chunks = [];
      let receivedBytes = 0;
      let startTime = null;

      peer.onDataChannel((channel) => {
        if (channel.label === 'control') {
          channel.onmessage = (event) => {
            const msg = JSON.parse(event.data);

            if (msg.type === 'file-meta') {
              fileMeta = msg;
              startTime = Date.now();

              document.getElementById('receiver-file-name').textContent = msg.name;
              document.getElementById('receiver-file-size').textContent = formatBytes(msg.size);
              showState(receiverReceiving);
            }

            if (msg.type === 'file-complete') {
              // Verify size
              if (fileMeta && receivedBytes !== fileMeta.size) {
                showError(`Transfer incomplete: received ${formatBytes(receivedBytes)} of ${formatBytes(fileMeta.size)}`);
                return;
              }

              // Assemble and download
              const blob = new Blob(chunks, { type: fileMeta.mimeType });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = fileMeta.name;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);

              document.getElementById('receiver-saved-name').textContent = fileMeta.name;
              showState(receiverComplete);
              cleanup();
            }
          };
        }

        if (channel.label === 'file') {
          channel.binaryType = 'arraybuffer';

          channel.onmessage = (event) => {
            chunks.push(event.data);
            receivedBytes += event.data.byteLength;

            if (fileMeta) {
              const pct = fileMeta.size > 0 ? (receivedBytes / fileMeta.size) * 100 : 100;
              document.getElementById('receiver-progress-fill').style.width = `${pct}%`;
              document.getElementById('receiver-progress-pct').textContent = `${Math.round(pct)}%`;
              document.getElementById('receiver-progress-detail').textContent =
                `${formatBytes(receivedBytes)} / ${formatBytes(fileMeta.size)}`;

              const elapsed = (Date.now() - startTime) / 1000;
              if (elapsed > 0.5) {
                const speed = receivedBytes / elapsed;
                document.getElementById('receiver-speed').textContent = formatSpeed(speed);
                const remaining = (fileMeta.size - receivedBytes) / speed;
                document.getElementById('receiver-eta').textContent = `~${formatTime(remaining)}`;
              }
            }
          };
        }
      });

      // Handle the offer and send answer
      try {
        await peer.handleOffer(msg.sdp);
      } catch {
        showError('Could not establish connection.');
      }
    });

    // Also handle the peer-joined event (we may already have connected)
    signaling.on('peer-joined', () => {
      // Sender will create the offer, we just wait
    });
  }

  connect();
}
