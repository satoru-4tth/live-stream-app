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
      if (!msg.isBroadcaster) name.style.color = nameColor(msg.name); // 名前ごとに色分け
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
      addTransient(wrap, pop, 3600);
      // 高額ほど派手に: 1,000 円以上で紙吹雪、5,000 円以上は大きなバナーつき
      if (msg.amount >= 1000) confetti(wrap, msg.amount >= 5000 ? 170 : 70);
      if (msg.amount >= 5000) {
        const banner = document.createElement("div");
        banner.className = "tip-banner";
        banner.textContent = `🎊 ${msg.name} さんから ${formatYen(msg.amount)}！ 🎊`;
        addTransient(wrap, banner, 4200);
      }
    }
  });
}

/** 映像の上に一時的な要素を足し、アニメーションが終わる頃に取り除く (画面が非表示で終了通知が来ない場合に備えて時間でも消す) */
function addTransient(wrap: HTMLElement, el: HTMLElement, ms: number) {
  wrap.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** 名前から決まる色 (同じ名前はいつも同じ色。チャットが見分けやすくなる) */
function nameColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 75% 70%)`;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 映像の上に紙吹雪を降らせる */
function confetti(wrap: HTMLElement, count: number) {
  if (reducedMotion()) return;
  const canvas = document.createElement("canvas");
  canvas.className = "confetti";
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const colors = ["#ff5d8f", "#ffd23f", "#3bceac", "#7c5cff", "#4cc9f0", "#ff9f1c"];
  const pieces = Array.from({ length: count }, () => ({
    x: Math.random() * canvas.width,
    y: -10 - Math.random() * canvas.height * 0.5,
    vx: (Math.random() - 0.5) * 3,
    vy: 2 + Math.random() * 3.5,
    size: 5 + Math.random() * 6,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));
  wrap.appendChild(canvas);
  const end = performance.now() + 3200;
  const tick = (now: number) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (now < end) requestAnimationFrame(tick);
    else canvas.remove();
  };
  requestAnimationFrame(tick);
  setTimeout(() => canvas.remove(), 4500); // 画面が非表示で描画が止まっても残らないように
}

/** 映像の上に流れるリアクション (配信者・視聴者共通) */
export function setupReactions(sig: Signaling) {
  const wrap = $(".video-wrap");
  sig.on((msg) => {
    if (msg.type !== "reaction" || reducedMotion()) return;
    const el = document.createElement("div");
    el.className = "reaction-pop";
    el.textContent = msg.emoji; // textContent で XSS 対策
    el.style.right = `${8 + Math.random() * 14}%`;
    el.style.setProperty("--drift", `${Math.round((Math.random() - 0.5) * 80)}px`);
    el.style.fontSize = `${26 + Math.round(Math.random() * 14)}px`;
    addTransient(wrap, el, 2800);
  });
}

/** 投げ銭の多い人 TOP3 の表示 (配信者・視聴者共通) */
export function setupSupporters(sig: Signaling) {
  const box = $("#supporters");
  const medals = ["🥇", "🥈", "🥉"];
  sig.on((msg) => {
    if (msg.type !== "supporters") return;
    box.hidden = msg.list.length === 0;
    box.replaceChildren();
    const title = document.createElement("span");
    title.className = "supporters-title";
    title.textContent = "🏆 サポーター";
    box.appendChild(title);
    msg.list.forEach((s, i) => {
      const item = document.createElement("span");
      item.className = "supporter";
      item.textContent = `${medals[i]} ${s.name} ${formatYen(s.total)}`;
      box.appendChild(item);
    });
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
