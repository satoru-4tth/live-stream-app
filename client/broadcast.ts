import type { ServerMessage, SignalData } from "../shared/protocol";
import { startBeauty } from "./beauty";
import { $, Signaling, loadIceServers, setupChat, setupTipDisplay, setViewerCount, elapsed } from "./common";

// ---------- 要素 ----------
const preview = $<HTMLVideoElement>("#preview");
const placeholder = $("#preview-placeholder");
const setupPanel = $("#setup-panel");
const livePanel = $("#live-panel");
const titleInput = $<HTMLInputElement>("#title");
const nameInput = $<HTMLInputElement>("#name");
const btnCamera = $<HTMLButtonElement>("#btn-camera");
const btnScreen = $<HTMLButtonElement>("#btn-screen");
const btnBeauty = $<HTMLButtonElement>("#btn-beauty");
const beautyInput = $<HTMLInputElement>("#beauty-level");
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
// カメラ・マイクは https (または localhost) のページでしか使えない。アプリ内ブラウザ (LINE など) でも使えないことがある
const hasMedia = !!navigator.mediaDevices?.getUserMedia;
const noMediaMessage = window.isSecureContext
  ? "このブラウザではカメラ・マイクを使えません。Safari / Chrome で直接開いてください（LINE などのアプリ内ブラウザでは使えないことがあります）"
  : "カメラ・マイクを使うには https:// のURLで開く必要があります";

async function useCamera() {
  if (!hasMedia) return showStatus(noMediaMessage, true);
  try {
    // 切替時は先に今のカメラを止める (スマホは同時に 2 つ開けないことがある)
    if (source === "camera") releaseCamera();
    const video = { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } };
    let stream: MediaStream;
    try {
      // 映像とマイクを 1 回で取得する (スマホは後からマイクだけ取り直すと、先のカメラが止まることがある)
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: !audioTrack });
    } catch (e) {
      // マイクが拒否・非対応でもカメラだけは映せるように、映像のみで取り直す
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      if (!audioTrack) {
        showStatus(`マイクを使えませんでした（${(e as Error).name}）。音声なしで配信されます。ブラウザのマイク許可を確認してください`, true);
      }
    }
    if (!audioTrack) setAudio(stream.getAudioTracks()[0] ?? null);
    rawCamera = stream.getVideoTracks()[0];
    applyCamera();
  } catch (e) {
    showStatus(`カメラを取得できませんでした: ${(e as Error).message}`, true);
  }
}

// ---------- 美顔補正 (カメラのみ) ----------
// カメラ映像から顔を見つけ、顔の部分だけを加工して配信する (処理の中身は beauty.ts)
let rawCamera: MediaStreamTrack | null = null; // 加工前のカメラ映像
let beautyOn = localStorageGet("beautyOn") === "1";
let beautyLevel = Math.min(100, Math.max(0, Number(localStorageGet("beautyLevel") ?? 50) || 0)); // 強さ 0〜100
let stopBeauty: (() => void) | null = null;
beautyInput.value = String(beautyLevel);

/** カメラ (と美顔の加工) をすべて止める */
function releaseCamera() {
  stopBeauty?.();
  stopBeauty = null;
  rawCamera?.stop();
  rawCamera = null;
}

/** 美顔の設定に合わせて、配信する映像を加工あり/なしに切り替える */
function applyCamera() {
  if (!rawCamera) return;
  stopBeauty?.();
  stopBeauty = null;
  if (!beautyOn) return setVideo(rawCamera, "camera");

  const beauty = startBeauty(rawCamera, () => beautyLevel);
  stopBeauty = beauty.stop;
  setVideo(beauty.track, "camera");
  const preparing = "美顔の準備中です…（初回は数秒かかります）";
  showStatus(preparing);
  beauty.ready.then((ok) => {
    if (stopBeauty !== beauty.stop) return; // その間に設定が変わった
    if (ok) {
      if (statusEl.textContent === preparing) showStatus("");
    } else {
      beautyOn = false;
      localStorageSet("beautyOn", "0");
      applyCamera();
      showStatus("顔認識を読み込めなかったため、美顔は使えません（通信状況を確認してください）", true);
    }
  });
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
    setVideo(track, "screen");
    if (!audioTrack) await tryMic();
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

    setVideo(track, "image");
    if (!audioTrack) await tryMic();
    showStatus(audioTrack ? "画像を配信映像に設定しました（マイク音声も配信されます）" : "画像を配信映像に設定しました（マイクなし）");
  } catch {
    showStatus("画像を読み込めませんでした", true);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** マイクを試す。拒否・非対応・許可ダイアログが応答しない場合でも、10 秒で諦めて先へ進む（マイクなしでも配信可能） */
function tryMic(): Promise<void> {
  return new Promise((resolve) => {
    if (!hasMedia) return resolve();
    const timer = setTimeout(resolve, 10000);
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => setAudio(s.getAudioTracks()[0] ?? null))
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
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
  if (old && old !== track && old !== rawCamera) old.stop(); // 美顔のオン/オフ切替では、元のカメラ映像は止めない
  if (kind !== "camera") releaseCamera(); // カメラ以外に切り替えたらカメラを解放
  updatePreview();
}

function setAudio(track: MediaStreamTrack | null) {
  audioTrack = track;
  // 配信中にマイクが後から使えるようになった場合も、接続済みの視聴者に音声を流す
  for (const pc of peers.values()) {
    pc.getTransceivers().find((t) => t.receiver.track.kind === "audio")?.sender.replaceTrack(track);
  }
  updatePreview();
}

function updatePreview() {
  const tracks = [videoTrack].filter(Boolean) as MediaStreamTrack[];
  preview.srcObject = tracks.length ? new MediaStream(tracks) : null; // 自分の音声はプレビューで鳴らさない
  placeholder.hidden = !!videoTrack;
  preview.classList.toggle("mirror", source === "camera"); // 自撮りのプレビューは左右反転
  btnBeauty.disabled = source !== "camera";
  btnBeauty.textContent = beautyOn ? "✨ 美顔 オン" : "✨ 美顔 オフ";
  btnBeauty.classList.toggle("active", beautyOn);
  beautyInput.disabled = !(beautyOn && source === "camera");
  btnCamera.classList.toggle("active", source === "camera");
  btnScreen.classList.toggle("active", source === "screen");
  btnImage.classList.toggle("active", source === "image");
  btnGoLive.disabled = !videoTrack || !!sig;
  btnMic.disabled = !audioTrack;
  btnMic.textContent = !audioTrack ? "🎤 マイクなし" : audioTrack.enabled ? "🎤 ミュート" : "🔇 ミュート解除";
}

btnCamera.onclick = useCamera;
btnBeauty.onclick = () => {
  beautyOn = !beautyOn;
  localStorageSet("beautyOn", beautyOn ? "1" : "0");
  applyCamera();
};
beautyInput.oninput = () => {
  beautyLevel = Number(beautyInput.value);
  localStorageSet("beautyLevel", String(beautyLevel)); // 強さは次のフレームから反映される
};
btnScreen.onclick = useScreen;
// 画面共有はスマホのブラウザでは使えないので、非対応ならボタンを隠す
if (!navigator.mediaDevices?.getDisplayMedia) btnScreen.hidden = true;
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
  setupTipDisplay(sig);
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
  const pc = new RTCPeerConnection({ iceServers: await loadIceServers() });
  peers.set(viewerId, pc);

  const stream = new MediaStream();
  if (videoTrack) pc.addTrack(videoTrack, stream);
  if (audioTrack) pc.addTrack(audioTrack, stream);
  else pc.addTransceiver("audio", { direction: "sendonly" }); // 音声の送り口だけ作っておき、マイクが使えたら差し替える

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
  releaseCamera();
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
if (!hasMedia) showStatus(`${noMediaMessage}（「画像」の配信は使えます）`, true);
