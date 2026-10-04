// 美顔補正: 顔だけに「肌をなめらかに・明るく」をかける。
// 顔の位置は MediaPipe の顔検出 (BlazeFace) で求める。モデルと WASM は自サーバーから配る
// (public/mediapipe/。WASM は npm run build で node_modules からコピー)。
import type { FaceDetector } from "@mediapipe/tasks-vision";

let detectorPromise: Promise<FaceDetector> | undefined;

/** 顔検出器を読み込む (初回のみ。ライブラリは必要になった時に読み込む)。GPU が使えなければ CPU で動かす */
function loadFaceDetector(): Promise<FaceDetector> {
  detectorPromise ??= (async () => {
    const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
    const create = (delegate: "GPU" | "CPU") =>
      FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "/mediapipe/blaze_face_short_range.tflite", delegate },
        runningMode: "VIDEO",
        minDetectionConfidence: 0.5,
      });
    try {
      return await create("GPU");
    } catch {
      return await create("CPU");
    }
  })();
  detectorPromise.catch(() => (detectorPromise = undefined)); // 失敗したら次回やり直せるように
  return detectorPromise;
}

interface Point {
  x: number;
  y: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 顔の特徴点 (px): 0=右目 1=左目 2=鼻 3=口 4,5=耳 */
  kp: Point[];
}

// 目・口のまわりは補正しない (ぼやけて不自然になるため)。[特徴点の番号, 顔の幅に対する半径]
const KEEP_SHARP: [number, number][] = [
  [0, 0.17],
  [1, 0.17],
  [3, 0.22],
];

const DETECT_INTERVAL = 60; // 顔検出は約 15 回/秒 (描画は約 30 回/秒)
const FACE_HOLD = 500; // 顔を見失っても、この時間 (ms) は直前の位置で補正を続ける

/**
 * カメラ映像を加工した映像トラックを返す。
 * 顔検出器の準備ができるまでは加工なしで流れ、準備できたら ready が true になる (失敗したら false)。
 */
export function startBeauty(raw: MediaStreamTrack, getLevel: () => number) {
  const src = document.createElement("video");
  src.muted = true;
  src.playsInline = true;
  src.srcObject = new MediaStream([raw]);
  src.play().catch(() => {});

  const out = document.createElement("canvas"); // 配信する映像
  const ctx = out.getContext("2d")!;
  const layer = document.createElement("canvas"); // 顔の補正を一時的に作る場所
  const lctx = layer.getContext("2d")!;
  const small = document.createElement("canvas"); // ぼかし用の縮小画像
  const sctx = small.getContext("2d")!;

  let detector: FaceDetector | null = null;
  let stopped = false;
  let face: Box | null = null;
  let faceSeenAt = 0;
  let lastDetect = 0;
  let lastTs = 0;

  const ready = loadFaceDetector().then(
    (d) => {
      if (!stopped) detector = d;
      return true;
    },
    () => false,
  );

  /** 映像から顔 (いちばん大きいもの) を探し、位置の急な揺れをならして記録する */
  const detect = (now: number) => {
    if (!detector || now - lastDetect < DETECT_INTERVAL) return;
    lastDetect = now;
    const ts = Math.max(now, lastTs + 1); // 検出器に渡す時刻は必ず増えていく必要がある
    lastTs = ts;
    let best: Box | null = null;
    for (const d of detector.detectForVideo(src, ts).detections) {
      const b = d.boundingBox;
      if (b && (!best || b.width > best.w)) {
        const kp = d.keypoints.map((p) => ({ x: p.x * src.videoWidth, y: p.y * src.videoHeight }));
        best = { x: b.originX, y: b.originY, w: b.width, h: b.height, kp };
      }
    }
    if (best) {
      faceSeenAt = now;
      face = face ? smooth(face, best) : best;
    } else if (now - faceSeenAt > FACE_HOLD) {
      face = null;
    }
  };

  const draw = () => {
    const w = src.videoWidth;
    const h = src.videoHeight;
    if (!w || src.readyState < 2) return; // まだ映像が来ていない
    if (out.width !== w || out.height !== h) {
      out.width = layer.width = w;
      out.height = layer.height = h;
      small.width = Math.ceil(w / 2);
      small.height = Math.ceil(h / 2);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(src, 0, 0, w, h);

    const now = performance.now();
    try {
      detect(now);
    } catch {
      /* 検出に失敗したフレームは加工しない */
    }
    const k = getLevel() / 100;
    if (!face || k === 0) return;

    // 顔のまわりの楕円 (顔の枠より少し広く、髪や背景はあまり含めない)
    const cx = face.x + face.w / 2;
    const cy = face.y + face.h / 2;
    const rx = face.w * 0.62;
    const ry = face.h * 0.72;
    const rx0 = Math.max(0, Math.floor(cx - rx));
    const ry0 = Math.max(0, Math.floor(cy - ry));
    const rw = Math.min(w, Math.ceil(cx + rx)) - rx0;
    const rh = Math.min(h, Math.ceil(cy + ry)) - ry0;
    if (rw < 8 || rh < 8) return;

    // ① 顔の範囲だけを縮小して拡大し、ぼかした画像を作る (顔が大きいほど強くぼかす)
    const f = Math.min(8, Math.max(2, face.w / 70));
    const sw = Math.max(2, Math.floor(rw / f));
    const sh = Math.max(2, Math.floor(rh / f));
    sctx.clearRect(0, 0, small.width, small.height);
    sctx.drawImage(src, rx0, ry0, rw, rh, 0, 0, sw, sh);
    lctx.globalCompositeOperation = "source-over";
    lctx.globalAlpha = 1;
    lctx.imageSmoothingEnabled = true;
    lctx.imageSmoothingQuality = "high";
    lctx.drawImage(small, 0, 0, sw, sh, rx0, ry0, rw, rh);

    // ② ほんのり明るく・暖かく (暖色の薄い色を「スクリーン」で重ねる)
    lctx.globalCompositeOperation = "screen";
    lctx.globalAlpha = k;
    lctx.fillStyle = "rgb(50, 38, 35)";
    lctx.fillRect(rx0, ry0, rw, rh);

    // ③ 楕円のふちをなだらかに透明にして、元の映像となじませる
    lctx.globalCompositeOperation = "destination-in";
    lctx.globalAlpha = 1;
    lctx.save();
    lctx.translate(cx, cy);
    lctx.scale(rx, ry);
    const g = lctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    const a = 0.7 * k; // 補正の最大の濃さ
    g.addColorStop(0, `rgba(0,0,0,${a})`);
    g.addColorStop(0.55, `rgba(0,0,0,${a})`);
    g.addColorStop(1, "rgba(0,0,0,0)");
    lctx.fillStyle = g;
    lctx.fillRect(-1, -1, 2, 2);
    lctx.restore();

    // ④ 目と口のまわりは補正を抜いて、くっきり残す
    lctx.globalCompositeOperation = "destination-out";
    for (const [i, ratio] of KEEP_SHARP) {
      const p = face.kp[i];
      if (!p) continue;
      const r = face.w * ratio;
      const hole = lctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      hole.addColorStop(0, "rgba(0,0,0,1)");
      hole.addColorStop(0.6, "rgba(0,0,0,0.85)");
      hole.addColorStop(1, "rgba(0,0,0,0)");
      lctx.fillStyle = hole;
      lctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    }

    ctx.drawImage(layer, rx0, ry0, rw, rh, rx0, ry0, rw, rh);
  };

  const timer = window.setInterval(draw, 33); // 約 30fps
  draw();

  const track = out.captureStream(30).getVideoTracks()[0];
  return {
    track,
    ready,
    stop() {
      stopped = true;
      clearInterval(timer);
      track.stop();
      src.srcObject = null;
    },
  };
}

function lerp(from: number, to: number): number {
  return from + (to - from) * 0.5;
}

/** 顔の位置を前回と今回の中間にして、小刻みな揺れをならす */
function smooth(prev: Box, next: Box): Box {
  return {
    x: lerp(prev.x, next.x),
    y: lerp(prev.y, next.y),
    w: lerp(prev.w, next.w),
    h: lerp(prev.h, next.h),
    kp: next.kp.map((p, i) => (prev.kp[i] ? { x: lerp(prev.kp[i].x, p.x), y: lerp(prev.kp[i].y, p.y) } : p)),
  };
}
