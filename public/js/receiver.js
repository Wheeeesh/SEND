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
  let done = false;

  function showState(el) {
    [receiverConnecting, receiverReceiving, receiverComplete, receiverError].forEach(
      s => s.hidden = true
    );
    el.hidden = false;
  }

  function showError(msg) {
    if (done) return;
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
      if (!done) {
        showError('Sender disconnected. Transfer cancelled.');
      }
    });

    signaling.on('close', () => {
      if (!peer && !done) {
        showError('Lost connection to server.');
      }
    });

    // Wait for offer from sender
    signaling.on('offer', async (msg) => {
      peer = new PeerConnection(signaling);

      peer.onConnectionStateChange = (state) => {
        if ((state === 'failed' || state === 'disconnected') && !done) {
          showError('Connection to sender lost.');
        }
      };

      // File transfer state
      let fileMeta = null;
      const chunks = [];
      let receivedBytes = 0;
      let startTime = null;
      let fileComplete = false;

      // Called when we have both all chunks AND the file-complete signal
      function tryFinalize() {
        if (!fileComplete) return;
        if (!fileMeta) return;
        if (receivedBytes !== fileMeta.size) return;

        done = true;

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

      peer.onDataChannel((channel) => {
        if (channel.label === 'control') {
          channel.onmessage = (event) => {
            let controlMsg;
            try {
              controlMsg = JSON.parse(event.data);
            } catch {
              return;
            }

            if (controlMsg.type === 'file-meta') {
              fileMeta = controlMsg;
              startTime = Date.now();

              document.getElementById('receiver-file-name').textContent = controlMsg.name;
              document.getElementById('receiver-file-size').textContent = formatBytes(controlMsg.size);
              showState(receiverReceiving);
            }

            if (controlMsg.type === 'file-complete') {
              fileComplete = true;
              tryFinalize();
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

              // Check if all bytes received — try finalize in case file-complete already arrived
              if (receivedBytes === fileMeta.size) {
                tryFinalize();
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

    // Sender will create the offer after peer-joined, we just wait
    signaling.on('peer-joined', () => {});
  }

  connect();
}
