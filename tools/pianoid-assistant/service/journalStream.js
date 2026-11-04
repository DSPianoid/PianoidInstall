/**
 * A READ-ONLY client of the backend's state broadcast (dev-tuneskill, observe mode): socket.io over the `ws`
 * dependency the service already has (Engine.IO protocol 4, websocket transport; the backend is Flask-SocketIO 5 /
 * python-engineio 4). It never emits a write event: it connects, answers pings, hands every server event to
 * `onEvent(name, payload)` and, after a reconnect, replays what it missed with the backend's own reconnect protocol
 * (`hello {clientId, boot, lastSeq}` -> the events after lastSeq from the journal ring, or `resync`; REST_API.md
 * "Reconnect protocol (I2)"). A resync (backend restarted, gap outside the ring) is reported as `onState('gap')`.
 *
 * Packets used: '0{...}' open -> send '40'; '40{...}' connected -> send hello as '42<ack>["hello",{...}]';
 * '2' ping -> '3'; '42["name",payload]' event; '43<ack>[reply]' the hello ack; '41' / close -> reconnect.
 */
import WebSocket from 'ws';

export const socketUrl = (backendUrl) => `${backendUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/socket.io/?EIO=4&transport=websocket`;

export class JournalStream {
  constructor({ url, onEvent, onState = () => {}, WebSocketImpl = WebSocket, retryMs = 2000, clientId = `assistant-observer-${process.pid}` }) {
    Object.assign(this, { url, onEvent, onState, WebSocketImpl, retryMs, clientId });
    this.ws = null;
    this.closed = false;
    this.boot = null;
    this.lastSeq = null;
    this.ackId = 0;
    this.timer = null;
  }

  start() {
    this.closed = false;
    this.connect();
    return this;
  }

  connect() {
    if (this.closed) return;
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.on('message', (data) => this.packet(String(data)));
    ws.on('close', () => this.retry());
    ws.on('error', () => {});                          // a close follows; the retry handles it
  }

  retry() {
    this.ws = null;
    if (this.closed) return;
    this.onState('disconnected');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.retryMs);
  }

  send(s) { if (this.ws && this.ws.readyState === 1) this.ws.send(s); }

  packet(p) {
    if (p === '2') return this.send('3');
    if (p.startsWith('0')) return this.send('40');
    if (p.startsWith('40')) {
      this.ackId += 1;
      return this.send(`42${this.ackId}${JSON.stringify(['hello', { clientId: this.clientId, boot: this.boot, lastSeq: this.lastSeq }])}`);
    }
    if (p.startsWith('41')) return this.ws?.close();
    if (p.startsWith('43')) return this.helloAck(JSON.parse(p.slice(2).replace(/^\d+/, ''))[0] || {});
    if (p.startsWith('42')) {
      const [name, payload] = JSON.parse(p.slice(2).replace(/^\d+/, ''));
      return this.event(name, payload);
    }
    return undefined;
  }

  helloAck(ack) {
    const reconnect = this.boot !== null;
    if (ack.resync && reconnect) this.onState('gap');
    this.boot = ack.boot ?? null;
    if (Array.isArray(ack.events)) for (const e of ack.events) this.event(e.event, e.payload);
    if (typeof ack.seq === 'number' && (this.lastSeq === null || ack.resync)) this.lastSeq = ack.seq;
    this.onState('connected');
  }

  event(name, payload) {
    const seq = payload?.seq;
    if (typeof seq === 'number') {
      if (this.lastSeq !== null && seq <= this.lastSeq) return;   // a replayed event already seen
      this.lastSeq = seq;
    }
    this.onEvent(name, payload);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}
