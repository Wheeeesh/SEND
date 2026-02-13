import { SignalingClient, getSignalingUrl } from './signaling.js';
import { PeerConnection } from './peer.js';
import { generateRoomId, formatBytes, formatSpeed, formatTime } from './utils.js';

const CHUNK_SIZE = 16384; // 16 KiB
const HIGH_WATER_MARK = 1048576; // 1 MiB
const LOW_WATER_MARK = 262144; // 256 KiB

export function initSender() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const senderIdle = document.getElementById('sender-idle');
  const senderReady = document.getElementById('sender-ready');
  const senderTransferring = document.getElementById('sender-transferring');
  const senderComplete = document.getElementById('sender-complete');
  const senderError = document.getElementById('sender-error');
  const senderErrorMsg = document.getElementById('sender-error-msg');
  const shareLink = document.getElementById('share-link');
  const copyBtn = document.getElementById('copy-btn');
  const sendAnother = document.getElementById('send-another');
  const senderRetry = document.getElementById('sender-retry');

  let selectedFile = null;
  let signaling = null;
  let peer = null;
  let transferStarted = false;

  function showState(el) {
    [senderIdle, senderReady, senderTransferring, senderComplete, senderError].forEach(
      s => s.hidden = true
    );
    el.hidden = false;
  }

  function showError(msg) {
    senderErrorMsg.textContent = msg;
    showState(senderError);
    cleanup();
  }

  function cleanup() {
    transferStarted = false;
    if (peer) { peer.close(); peer = null; }
    if (signaling) { signaling.close(); signaling = null; }
  }

  // Drag and drop
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleFile(fileInput.files[0]);
    }
  });

  async function handleFile(file) {
    selectedFile = file;

    // Show file info
    document.getElementById('sender-file-name').textContent = file.name;
    document.getElementById('sender-file-size').textContent = formatBytes(file.size);
    document.getElementById('sender-transfer-name').textContent = file.name;
    document.getElementById('sender-transfer-size').textContent = formatBytes(file.size);

    // Generate room and link
    const roomId = generateRoomId();
    const link = `${location.origin}/#/r/${roomId}`;
    shareLink.value = link;

    showState(senderReady);
    document.getElementById('sender-status').innerHTML =
      '<div class="spinner"></div><span>Waiting for receiver...</span>';

    // Connect to signaling server
    try {
      signaling = new SignalingClient(getSignalingUrl());
      await signaling.connect();
      signaling.joinRoom(roomId);
    } catch {
      showError('Could not connect to server. Please try again.');
      return;
    }

    // Wait for peer — only start transfer once
    signaling.on('peer-joined', () => {
      if (!transferStarted) {
        transferStarted = true;
        startTransfer();
      }
    });

    signaling.on('error', (msg) => {
      showError(msg.message || 'Connection error');
    });
  }

  async function startTransfer() {
    peer = new PeerConnection(signaling);

    // Create data channels BEFORE the offer
    const controlChannel = peer.createDataChannel('control');
    const fileChannel = peer.createDataChannel('file', { ordered: true });
    fileChannel.binaryType = 'arraybuffer';

    // Register answer handler BEFORE creating offer
    signaling.on('answer', async (msg) => {
      await peer.handleAnswer(msg.sdp);
    });

    // Monitor connection
    peer.onConnectionStateChange = (state) => {
      if (state === 'failed' || state === 'disconnected') {
        showError('Connection to receiver lost.');
      }
    };

    signaling.on('peer-left', () => {
      showError('Receiver disconnected.');
    });

    // Wait for BOTH channels to open before sending
    let controlOpen = false;
    let fileOpen = false;

    controlChannel.onopen = () => {
      controlOpen = true;
      if (fileOpen) startSending();
    };

    fileChannel.onopen = () => {
      fileOpen = true;
      if (controlOpen) startSending();
    };

    function startSending() {
      showState(senderTransferring);
      sendFileData(controlChannel, fileChannel);
    }

    // Create offer — this triggers the whole WebRTC negotiation
    try {
      await peer.createOffer();
    } catch {
      showError('Could not establish connection.');
    }
  }

  async function sendFileData(controlChannel, fileChannel) {
    // Send metadata on control channel
    controlChannel.send(JSON.stringify({
      type: 'file-meta',
      name: selectedFile.name,
      size: selectedFile.size,
      mimeType: selectedFile.type || 'application/octet-stream',
    }));

    const progressFill = document.getElementById('sender-progress-fill');
    const progressPct = document.getElementById('sender-progress-pct');
    const progressDetail = document.getElementById('sender-progress-detail');
    const speedEl = document.getElementById('sender-speed');
    const etaEl = document.getElementById('sender-eta');

    let offset = 0;
    const startTime = Date.now();

    function updateProgress() {
      const pct = selectedFile.size > 0 ? (offset / selectedFile.size) * 100 : 100;
      progressFill.style.width = `${pct}%`;
      progressPct.textContent = `${Math.round(pct)}%`;
      progressDetail.textContent = `${formatBytes(offset)} / ${formatBytes(selectedFile.size)}`;

      const elapsed = (Date.now() - startTime) / 1000;
      if (elapsed > 0.5) {
        const speed = offset / elapsed;
        speedEl.textContent = formatSpeed(speed);
        const remaining = (selectedFile.size - offset) / speed;
        etaEl.textContent = `~${formatTime(remaining)}`;
      }
    }

    // Read entire file into memory, then send chunks synchronously
    const fileBuffer = await selectedFile.arrayBuffer();

    function sendNextChunk() {
      while (offset < fileBuffer.byteLength) {
        if (fileChannel.bufferedAmount > HIGH_WATER_MARK) {
          fileChannel.bufferedAmountLowThreshold = LOW_WATER_MARK;
          fileChannel.onbufferedamountlow = () => {
            fileChannel.onbufferedamountlow = null;
            sendNextChunk();
          };
          return;
        }

        const end = Math.min(offset + CHUNK_SIZE, fileBuffer.byteLength);
        const chunk = fileBuffer.slice(offset, end);

        try {
          fileChannel.send(chunk);
        } catch {
          showError('Transfer failed.');
          return;
        }

        offset = end;
        updateProgress();
      }

      // All chunks queued on the file channel.
      // Wait for buffer to fully drain before sending file-complete on control channel.
      // This ensures all file data is sent before the completion signal.
      const waitForDrain = () => {
        if (fileChannel.bufferedAmount === 0) {
          // Additional delay to ensure receiver processes file chunks
          // before the control message arrives (separate channel, may be faster)
          setTimeout(() => {
            controlChannel.send(JSON.stringify({ type: 'file-complete' }));
            showState(senderComplete);
          }, 200);
        } else {
          setTimeout(waitForDrain, 50);
        }
      };
      waitForDrain();
    }

    sendNextChunk();
  }

  // Copy link
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(shareLink.value).then(() => {
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('copied');
      }, 2000);
    });
  });

  // Send another
  sendAnother.addEventListener('click', () => {
    cleanup();
    selectedFile = null;
    fileInput.value = '';
    showState(senderIdle);
  });

  // Retry
  senderRetry.addEventListener('click', () => {
    cleanup();
    selectedFile = null;
    fileInput.value = '';
    showState(senderIdle);
  });
}
