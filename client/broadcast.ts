import { ICE_SERVERS, type ServerMessage, type SignalData } from "../shared/protocol";
import { $, Signaling, setupChat, setViewerCount, elapsed } from "./common";

// ---------- 要素 ----------
const preview = $<HTMLVideoElement>("#preview");
const placeholder = $("#preview-placeholder");
const setupPanel = $("#setup-panel");
const livePanel = $("#live-panel");
const titleInput = $<HTMLInputElement>("#title");
const nameInput = $<HTMLInputElement>("#name");
const btnCamera = $<HTMLButtonElement>("#btn-camera");
const btnScreen = $<HTMLButtonElement>("#btn-screen");
const btnMic = $<HTMLButtonElement>("#btn-mic");
const btnGoLive = $<HTMLButtonElement>("#btn-go-live");
const btnEnd = $<HTMLButtonElement>("#btn-end");
const shareLink = $<HTMLInputElement>("#share-link");
const btnCopy = $<HTMLButtonElement>("#btn-copy");
const liveTimer = $("#live-timer");
const statusEl = $("#status");

// ---------- 状態 ----------
let videoTrack: MediaStreamTrack | null = null;
let audioTrack: MediaStreamTrack | null = null;
let source: "camera" | "screen" | null = null;
let sig: Signaling | null = null;
const peers = new Map<string, RTCPeerConnection>();

nameInput.value = localStorageGet("name") ?? "";

// ---------- メディア取得 ----------
async function useCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: !audioTrack,
    });
    if (!audioTrack) setAudio(stream.getAudioTracks()[0] ?? null);
    setVideo(stream.getVideoTracks()[0], "camera");
  } catch (e) {
    showStatus(`カメラを取得できませんでした: ${(e as Error).message}`, true);
  }
}

async function useScreen() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    const track = stream.getVideoTracks()[0];
    // ブラウザの「共有を停止」ボタンで止められたらカメラに戻す
    track.addEventListener("ended", () => {
      if (videoTrack === track) useCamera();
    });
    if (!audioTrack) await tryMic();
    setVideo(track, "screen");
  } catch (e) {
    showStatus(`画面共有を開始できませんでした: ${(e as Error).message}`, true);
  }
}

async function tryMic() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    setAudio(s.getAudioTracks()[0] ?? null);
  } catch {
    /* マイクなしでも配信可能 */
  }
}

function setVideo(track: MediaStreamTrack, kind: "camera" | "screen") {
  const old = videoTrack;
  videoTrack = track;
  source = kind;
  // 配信中なら全視聴者への送信トラックを差し替え (再接続不要)
  for (const pc of peers.values()) {
    const sender = pc.getSenders().find((s) => s.track?.kind === "video" || s.track === old);
    sender?.replaceTrack(track);
  }
  if (old && old !== track) old.stop();
  // 配信開始前はチャット送信でページがリロードされないように
$<HTMLFormElement>("#chat-form").addEventListener("submit", (e) => e.preventDefault());

updatePreview();
}

function setAudio(track: MediaStreamTrack | null) {
  audioTrack = track;
  // 配信開始前はチャット送信でページがリロードされないように
$<HTMLFormElement>("#chat-form").addEventListener("submit", (e) => e.preventDefault());

updatePreview();
}

function updatePreview() {
  const tracks = [videoTrack].filter(Boolean) as MediaStreamTrack[];
  preview.srcObject = tracks.length ? new MediaStream(tracks) : null; // 自分の音声はプレビューで鳴らさない
  placeholder.hidden = !!videoTrack;
  preview.classList.toggle("mirror", source === "camera");
  btnCamera.classList.toggle("active", source === "camera");
  btnScreen.classList.toggle("active", source === "screen");
  btnGoLive.disabled = !videoTrack || !!sig;
  btnMic.disabled = !audioTrack;
  btnMic.textContent = !audioTrack ? "🎤 マイクなし" : audioTrack.enabled ? "🎤 ミュート" : "🔇 ミュート解除";
}

btnCamera.onclick = useCamera;
btnScreen.onclick = useScreen;
btnMic.onclick = () => {
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  // 配信開始前はチャット送信でページがリロードされないように
$<HTMLFormElement>("#chat-form").addEventListener("submit", (e) => e.preventDefault());

updatePreview();
};

// ---------- 配信開始 ----------
btnGoLive.onclick = async () => {
  if (!videoTrack) return;
  btnGoLive.disabled = true;
  localStorageSet("name", nameInput.value);
  sig = new Signaling();
  try {
    await sig.ready;
  } catch (e) {
    showStatus((e as Error).message, true);
    sig = null;
    btnGoLive.disabled = false;
    return;
  }
  setupChat(sig);
  sig.on(onMessage);
  sig.send({ type: "create-room", title: titleInput.value, name: nameInput.value });
};

let startedAt = 0;
let timer = 0;

function onMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "room-created": {
      startedAt = Date.now();
      setupPanel.hidden = true;
      livePanel.hidden = false;
      document.body.classList.add("is-live");
      shareLink.value = `${location.origin}/watch?room=${msg.roomId}`;
      timer = window.setInterval(() => (liveTimer.textContent = elapsed(startedAt)), 1000);
      showStatus("配信中です。リンクを共有して視聴者を招待しましょう。");
      break;
    }
    case "viewer-joined":
      connectViewer(msg.viewerId);
      break;
    case "viewer-left":
      peers.get(msg.viewerId)?.close();
      peers.delete(msg.viewerId);
      break;
    case "signal":
      enqueue(msg.from, () => handleSignal(msg.from, msg.data));
      break;
    case "viewer-count":
      setViewerCount(msg.count);
      break;
    case "error":
      showStatus(msg.message, true);
      break;
  }
}

// ---------- WebRTC (配信者 → 視聴者ごとに 1 本の接続) ----------
async function connectViewer(viewerId: string) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers.set(viewerId, pc);

  const stream = new MediaStream();
  if (videoTrack) pc.addTrack(videoTrack, stream);
  if (audioTrack) pc.addTrack(audioTrack, stream);

  pc.onicecandidate = (e) => {
    if (e.candidate) sig?.send({ type: "signal", to: viewerId, data: { candidate: e.candidate.toJSON() } });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      pc.close();
      peers.delete(viewerId);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sig?.send({ type: "signal", to: viewerId, data: { sdp: pc.localDescription!.toJSON() } });
}

async function handleSignal(from: string, data: SignalData) {
  const pc = peers.get(from);
  if (!pc) return;
  if ("sdp" in data) await pc.setRemoteDescription(data.sdp);
  else await pc.addIceCandidate(data.candidate).catch(() => {});
}

// シグナル処理を相手ごとに直列化 (SDP 設定前に ICE 候補を追加しないため)
const queues = new Map<string, Promise<void>>();
function enqueue(id: string, fn: () => Promise<void>) {
  const prev = queues.get(id) ?? Promise.resolve();
  queues.set(id, prev.then(fn).catch((e) => console.error(e)));
}

// ---------- 配信終了 ----------
btnEnd.onclick = () => {
  if (!confirmEnd()) return;
  sig?.send({ type: "end-room" });
  sig?.close();
  sig = null;
  for (const pc of peers.values()) pc.close();
  peers.clear();
  clearInterval(timer);
  videoTrack?.stop();
  audioTrack?.stop();
  location.href = "/";
};

function confirmEnd() {
  return window.confirm("配信を終了しますか？");
}

btnCopy.onclick = async () => {
  await navigator.clipboard.writeText(shareLink.value).catch(() => shareLink.select());
  btnCopy.textContent = "コピーしました";
  setTimeout(() => (btnCopy.textContent = "コピー"), 1500);
};

window.addEventListener("beforeunload", (e) => {
  if (sig) e.preventDefault();
});

function showStatus(text: string, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function localStorageGet(k: string) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* noop */ }
}

// 配信開始前はチャット送信でページがリロードされないように
$<HTMLFormElement>("#chat-form").addEventListener("submit", (e) => e.preventDefault());

updatePreview();
