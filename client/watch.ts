import { REACTIONS, TIP_AMOUNTS, type ServerMessage, type SignalData } from "../shared/protocol";
import { $, Signaling, formatYen, loadIceServers, setupChat, setupReactions, setupSupporters, setupTipDisplay, setViewerCount } from "./common";

const video = $<HTMLVideoElement>("#remote");
const overlay = $("#overlay");
const titleEl = $("#title");
const byEl = $("#broadcaster");
const btnUnmute = $<HTMLButtonElement>("#btn-unmute");
const audioNotice = $("#audio-notice");
const joinForm = $<HTMLFormElement>("#join-form");
const nameInput = $<HTMLInputElement>("#name");

const roomId = new URLSearchParams(location.search).get("room");
let pc: RTCPeerConnection | null = null;
let broadcasterId = "";
let queue = Promise.resolve();

try { nameInput.value = localStorage.getItem("viewerName") ?? ""; } catch { /* noop */ }

if (!roomId) {
  showOverlay("配信IDが指定されていません");
} else {
  // 配信情報を先に表示
  fetch(`/api/rooms/${encodeURIComponent(roomId)}`)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((r) => {
      titleEl.textContent = r.title;
      byEl.textContent = r.broadcasterName;
      document.title = `${r.title} - LiveStream`;
    })
    .catch(() => showOverlay("配信が見つかりません（終了した可能性があります）"));

  start(roomId);
}

async function start(id: string) {
  const sig = new Signaling();
  try {
    await sig.ready;
  } catch (e) {
    return showOverlay((e as Error).message);
  }
  setupChat(sig);
  setupTipDisplay(sig);
  setupReactions(sig);
  setupSupporters(sig);
  setupTipButtons(sig);
  setupReactionButtons(sig);

  sig.on((msg) => onMessage(sig, msg));
  sig.send({ type: "join-room", roomId: id, name: nameInput.value });

  // 表示名の変更
  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    sig.send({ type: "set-name", name });
    try { localStorage.setItem("viewerName", name); } catch { /* noop */ }
    nameInput.blur();
  });
}

function setupReactionButtons(sig: Signaling) {
  const box = $("#reaction-buttons");
  for (const emoji of REACTIONS) {
    const b = document.createElement("button");
    b.className = "reaction-btn";
    b.textContent = emoji;
    b.setAttribute("aria-label", `リアクション ${emoji}`);
    b.onclick = () => sig.send({ type: "reaction", emoji });
    box.appendChild(b);
  }
}

function setupTipButtons(sig: Signaling) {
  const box = $("#tip-buttons");
  for (const amount of TIP_AMOUNTS) {
    const b = document.createElement("button");
    b.className = "btn tip-btn";
    b.textContent = formatYen(amount);
    b.onclick = () => sig.send({ type: "tip", amount });
    box.appendChild(b);
  }
}

function onMessage(sig: Signaling, msg: ServerMessage) {
  switch (msg.type) {
    case "joined":
      broadcasterId = msg.broadcasterId;
      titleEl.textContent = msg.title;
      byEl.textContent = msg.broadcasterName;
      showOverlay("接続中…");
      break;
    case "signal":
      if (msg.from !== broadcasterId) return;
      queue = queue.then(() => handleSignal(sig, msg.data)).catch((e) => console.error(e));
      break;
    case "viewer-count":
      setViewerCount(msg.count);
      break;
    case "room-ended":
      pc?.close();
      video.srcObject = null;
      showOverlay("配信は終了しました");
      break;
    case "error":
      showOverlay(msg.message);
      break;
  }
}

async function handleSignal(sig: Signaling, data: SignalData) {
  if ("sdp" in data) {
    if (data.sdp.type !== "offer") return;
    pc?.close();
    pc = createPeer(sig, await loadIceServers());
    await pc.setRemoteDescription(data.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sig.send({ type: "signal", to: broadcasterId, data: { sdp: pc.localDescription!.toJSON() } });
  } else if (pc) {
    await pc.addIceCandidate(data.candidate).catch(() => {});
  }
}

function createPeer(sig: Signaling, iceServers: RTCIceServer[]) {
  const p = new RTCPeerConnection({ iceServers });
  const stream = new MediaStream();
  video.srcObject = stream;

  p.ontrack = (e) => {
    stream.addTrack(e.track);
    hideOverlay();
    video.play().catch(() => {
      // 自動再生がブロックされた場合はミュートで再生
      video.muted = true;
      video.play();
      btnUnmute.hidden = false;
    });
  };
  p.onicecandidate = (e) => {
    if (e.candidate) sig.send({ type: "signal", to: broadcasterId, data: { candidate: e.candidate.toJSON() } });
  };
  p.onconnectionstatechange = () => {
    if (p.connectionState === "failed") showOverlay("接続に失敗しました（ネットワーク環境によっては TURN サーバーが必要です）");
    if (p.connectionState === "connected") {
      hideOverlay();
      setTimeout(checkAudio, 4000);
    }
  };
  return p;
}

btnUnmute.onclick = async () => {
  video.muted = false;
  video.volume = 1;
  await video.play().catch(() => {});
  btnUnmute.hidden = true;
  setTimeout(checkAudio, 1500);
};

/** 配信者の音声が実際に届いているか確認し、届いていなければ理由を表示する */
async function checkAudio() {
  if (!pc || pc.connectionState !== "connected") return;
  let bytes = 0;
  (await pc.getStats()).forEach((r) => {
    if (r.type === "inbound-rtp" && r.kind === "audio") bytes += r.bytesReceived ?? 0;
  });
  audioNotice.hidden = bytes > 0;
  audioNotice.textContent = "配信者の音声が届いていません（配信者のマイクが使えない状態の可能性があります）";
}

function showOverlay(text: string) {
  overlay.textContent = text;
  overlay.hidden = false;
}
function hideOverlay() {
  overlay.hidden = true;
}
