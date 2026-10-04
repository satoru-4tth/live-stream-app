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
const btnImage = $<HTMLButtonElement>("#btn-image");
const imageInput = $<HTMLInputElement>("#image-input");
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
type Source = "camera" | "screen" | "image";
let source: Source | null = null;
let imageTimer = 0; // 画像配信時のフレーム送出タイマー
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
    track.contentHint = "detail"; // 文字が読めるよう画質優先
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

/**
 * 画像配信: 選んだ画像を canvas に描き、canvas を映像トラックとして配信する。
 * カメラ・画面共有なしでも配信でき、マイクがあれば音声だけ乗せられる（ラジオ風）。
 */
async function useImage(file: File) {
  if (!file.type.startsWith("image/")) {
    return showStatus("画像ファイルを選んでください", true);
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();

    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d")!;
    const draw = () => {
      // 16:9 の黒背景に、縦横比を保って中央に収める
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    };
    draw();

    // 静止画は変化がないとフレームが送られないため、定期的に描き直して送出する
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    track.contentHint = "detail"; // 静止画なので画質（解像度）優先でエンコード
    clearInterval(imageTimer);
    imageTimer = window.setInterval(() => {
      draw();
      track.requestFrame?.();
    }, 500);

    if (!audioTrack) await tryMic();
    setVideo(track, "image");
    showStatus(audioTrack ? "画像を配信映像に設定しました（マイク音声も配信されます）" : "画像を配信映像に設定しました（マイクなし）");
  } catch {
    showStatus("画像を読み込めませんでした", true);
  } finally {
    URL.revokeObjectURL(url);
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

function setVideo(track: MediaStreamTrack, kind: Source) {
  const old = videoTrack;
  if (kind !== "image") clearInterval(imageTimer); // 画像以外に切り替えたら描画を止める
  videoTrack = track;
  source = kind;
  // 配信中なら全視聴者への送信トラックを差し替え (再接続不要)
  for (const pc of peers.values()) {
    const sender = pc.getSenders().find((s) => s.track?.kind === "video" || s.track === old);
    sender?.replaceTrack(track);
  }
  if (old && old !== track) old.stop();
  updatePreview();
}

function setAudio(track: MediaStreamTrack | null) {
  audioTrack = track;
  updatePreview();
}

function updatePreview() {
  const tracks = [videoTrack].filter(Boolean) as MediaStreamTrack[];
  preview.srcObject = tracks.length ? new MediaStream(tracks) : null; // 自分の音声はプレビューで鳴らさない
  placeholder.hidden = !!videoTrack;
  preview.classList.toggle("mirror", source === "camera");
  btnCamera.classList.toggle("active", source === "camera");
  btnScreen.classList.toggle("active", source === "screen");
  btnImage.classList.toggle("active", source === "image");
  btnGoLive.disabled = !videoTrack || !!sig;
  btnMic.disabled = !audioTrack;
  btnMic.textContent = !audioTrack ? "🎤 マイクなし" : audioTrack.enabled ? "🎤 ミュート" : "🔇 ミュート解除";
}

btnCamera.onclick = useCamera;
btnScreen.onclick = useScreen;
btnImage.onclick = () => imageInput.click();
imageInput.onchange = () => {
  const file = imageInput.files?.[0];
  if (file) useImage(file);
  imageInput.value = ""; // 同じ画像を選び直せるように
};
btnMic.onclick = () => {
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
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
      $<HTMLInputElement>("#chat-input").placeholder = "コメントする…";
      timer = window.setInterval(() => (liveTimer.textContent = elapsed(startedAt)), 1000);
      startThumbnails();
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
    case "request-thumbnail":
      sendThumbnail(); // 誰かが一覧ページを開いた → 今の画面を送る
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

// ---------- サムネイル (配信一覧に表示) ----------
let thumbTimer = 0;
const thumbCanvas = document.createElement("canvas");
thumbCanvas.width = 480;
thumbCanvas.height = 270;

function sendThumbnail() {
  if (!sig || preview.videoWidth === 0) return;
  const ctx = thumbCanvas.getContext("2d")!;
  const { width: W, height: H } = thumbCanvas;
  // 16:9 に収まるよう中央を切り抜き (視聴者と同じく左右反転なし)
  const scale = Math.max(W / preview.videoWidth, H / preview.videoHeight);
  const w = preview.videoWidth * scale;
  const h = preview.videoHeight * scale;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(preview, (W - w) / 2, (H - h) / 2, w, h);
  sig.send({ type: "thumbnail", dataUrl: thumbCanvas.toDataURL("image/jpeg", 0.7) });
}

/** 配信開始時に 1 枚撮影。以降は一覧ページが開かれたときだけ撮影する */
function startThumbnails() {
  thumbTimer = window.setTimeout(sendThumbnail, 1500);
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
  clearInterval(imageTimer);
  clearTimeout(thumbTimer);
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
