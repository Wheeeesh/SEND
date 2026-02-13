const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class PeerConnection {
  constructor(signaling) {
    this.signaling = signaling;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Trickle ICE: send candidates as they arrive
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.send({
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Listen for remote ICE candidates
    this.signaling.on('ice-candidate', (msg) => {
      this.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
    });

    this.onConnectionStateChange = null;

    this.pc.oniceconnectionstatechange = () => {
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(this.pc.iceConnectionState);
      }
    };
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.signaling.send({ type: 'offer', sdp: this.pc.localDescription.toJSON() });
  }

  async handleOffer(sdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.signaling.send({ type: 'answer', sdp: this.pc.localDescription.toJSON() });
  }

  async handleAnswer(sdp) {
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));
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
