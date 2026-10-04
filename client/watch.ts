import { ICE_SERVERS, type ServerMessage, type SignalData } from "../shared/protocol";
import { $, Signaling, setupChat, setViewerCount } from "./common";

const video = $<HTMLVideoElement>("#remote");
const overlay = $("#overlay");
const titleEl = $("#title");
const byEl = $("#broadcaster");
const btnUnmute = $<HTMLButtonElement>("#btn-unmute");
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
    pc = createPeer(sig);
    await pc.setRemoteDescription(data.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sig.send({ type: "signal", to: broadcasterId, data: { sdp: pc.localDescription!.toJSON() } });
  } else if (pc) {
    await pc.addIceCandidate(data.candidate).catch(() => {});
  }
}

function createPeer(sig: Signaling) {
  const p = new RTCPeerConnection({ iceServers: ICE_SERVERS });
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
    if (p.connectionState === "connected") hideOverlay();
  };
  return p;
}

btnUnmute.onclick = () => {
  video.muted = false;
  btnUnmute.hidden = true;
};

function showOverlay(text: string) {
  overlay.textContent = text;
  overlay.hidden = false;
}
function hideOverlay() {
  overlay.hidden = true;
}
