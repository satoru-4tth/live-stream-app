import { ICE_SERVERS, type ClientMessage, type ServerMessage } from "../shared/protocol";

let iceServers: Promise<RTCIceServer[]> | undefined;
/** サーバーから WebRTC の接続先候補 (STUN / TURN) を取得する。取得できなければ既定値を使う */
export function loadIceServers(): Promise<RTCIceServer[]> {
  iceServers ??= fetch("/api/ice-servers")
    .then((r) => (r.ok ? (r.json() as Promise<RTCIceServer[]>) : ICE_SERVERS))
    .catch(() => ICE_SERVERS);
  return iceServers;
}

/** 型付き WebSocket ラッパー */
export class Signaling {
  private ws: WebSocket;
  private handlers: ((msg: ServerMessage) => void)[] = [];
  readonly ready: Promise<void>;

  constructor() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("サーバーに接続できません")), { once: true });
    });
    this.ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data) as ServerMessage;
      this.handlers.forEach((h) => h(msg));
    });
    this.ws.addEventListener("close", () => {
      this.handlers.forEach((h) => h({ type: "system", text: "サーバーとの接続が切れました" }));
    });
  }

  on(handler: (msg: ServerMessage) => void) {
    this.handlers.push(handler);
  }

  send(msg: ClientMessage) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.ws.close();
  }
}

export function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`要素が見つかりません: ${selector}`);
  return el;
}

/** チャット欄のセットアップ (配信者・視聴者共通) */
export function setupChat(sig: Signaling) {
  const log = $("#chat-log");
  const form = $<HTMLFormElement>("#chat-form");
  const input = $<HTMLInputElement>("#chat-input");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sig.send({ type: "chat", text });
    input.value = "";
  });

  const append = (el: HTMLElement) => {
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.appendChild(el);
    if (atBottom) log.scrollTop = log.scrollHeight;
  };

  sig.on((msg) => {
    if (msg.type === "chat") {
      const row = document.createElement("div");
      row.className = "chat-row" + (msg.isBroadcaster ? " is-broadcaster" : "");
      const name = document.createElement("span");
      name.className = "chat-name";
      name.textContent = msg.name + (msg.isBroadcaster ? " 🎙" : "");
      const text = document.createElement("span");
      text.className = "chat-text";
      text.textContent = msg.text; // textContent で XSS 対策
      row.append(name, text);
      append(row);
    } else if (msg.type === "tip") {
      const row = document.createElement("div");
      row.className = "chat-row chat-tip";
      row.textContent = `💰 ${msg.name} さんが ${formatYen(msg.amount)} を投げ銭しました！`;
      append(row);
    } else if (msg.type === "system") {
      const row = document.createElement("div");
      row.className = "chat-system";
      row.textContent = msg.text;
      append(row);
    }
  });
}

export function formatYen(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

/** 投げ銭の累計表示と、映像上に流れる演出 (配信者・視聴者共通) */
export function setupTipDisplay(sig: Signaling) {
  const wrap = $(".video-wrap");
  sig.on((msg) => {
    if (msg.type === "tip-total") {
      document.querySelectorAll(".tip-total").forEach((el) => (el.textContent = formatYen(msg.total)));
    } else if (msg.type === "tip") {
      const pop = document.createElement("div");
      pop.className = "tip-pop";
      pop.textContent = `💰 ${msg.name} ${formatYen(msg.amount)}`;
      wrap.appendChild(pop);
      pop.addEventListener("animationend", () => pop.remove());
    }
  });
}

export function setViewerCount(count: number) {
  document.querySelectorAll(".viewer-count").forEach((el) => (el.textContent = String(count)));
}

export function elapsed(startedAt: number): string {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
