const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

export class PeerConnection {
  constructor(signaling) {
    this.signaling = signaling;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this._localDescriptionSet = false;
    this._remoteDescriptionSet = false;
    this._pendingCandidates = [];

    // Trickle ICE: send candidates as they arrive
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.send({
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Queue ICE candidates until remote description is set
    this.signaling.on('ice-candidate', async (msg) => {
      if (this._remoteDescriptionSet) {
        await this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      } else {
        this._pendingCandidates.push(msg.candidate);
      }
    });

    this.onConnectionStateChange = null;

    this.pc.oniceconnectionstatechange = () => {
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(this.pc.iceConnectionState);
      }
    };
  }

  async _applyPendingCandidates() {
    for (const candidate of this._pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    }
    this._pendingCandidates = [];
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this._localDescriptionSet = true;
    this.signaling.send({ type: 'offer', sdp: this.pc.localDescription.toJSON() });
  }

  async handleOffer(sdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this._remoteDescriptionSet = true;
    await this._applyPendingCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this._localDescriptionSet = true;
    this.signaling.send({ type: 'answer', sdp: this.pc.localDescription.toJSON() });
  }

  async handleAnswer(sdp) {
    // Wait until local description is set (createOffer must complete first)
    if (!this._localDescriptionSet) {
      await new Promise((resolve) => {
        const check = () => {
          if (this._localDescriptionSet) resolve();
          else setTimeout(check, 10);
        };
        check();
      });
    }
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    this._remoteDescriptionSet = true;
    await this._applyPendingCandidates();
  }

  createDataChannel(label, opts) {
    return this.pc.createDataChannel(label, opts);
  }

  onDataChannel(callback) {
    this.pc.ondatachannel = (event) => callback(event.channel);
  }

  close() {
    this.pc.close();
  }
}
