// 着ぐるみエフェクト: 検出した顔のまわりに、動物のフード (耳つき) と鼻・ほっぺ・ひげを描く。
// 画像素材は使わず、すべて canvas で描く。顔の部分はフードの穴から本物の顔が見える。
// 顔の傾き (両目を結ぶ線) に合わせて回転するので、首をかしげても耳がついてくる。

export type Costume = "none" | "cat" | "bear" | "rabbit" | "dog";

export const COSTUMES: { id: Costume; label: string }[] = [
  { id: "none", label: "🚫 なし" },
  { id: "cat", label: "🐱 ねこ" },
  { id: "bear", label: "🐻 くま" },
  { id: "rabbit", label: "🐰 うさぎ" },
  { id: "dog", label: "🐶 いぬ" },
];

/** 顔の位置 (px)。特徴点: 0=右目 1=左目 2=鼻 3=口 4,5=耳 */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  kp: { x: number; y: number }[];
}

interface Look {
  fur: string; // フードの色
  trim: string; // ふちの濃い色
  ear: string; // 耳の外側の色
  inner: string; // 耳の内側の色
  nose: string;
  noseSize: number; // 顔の幅に対する鼻の大きさ
}

const LOOKS: Record<Exclude<Costume, "none">, Look> = {
  cat: { fur: "#f2a65a", trim: "#c97a2e", ear: "#f2a65a", inner: "#ffb6c1", nose: "#ff7a9a", noseSize: 0.07 },
  bear: { fur: "#9a6540", trim: "#6b4226", ear: "#9a6540", inner: "#d9a37a", nose: "#2b1a12", noseSize: 0.08 },
  rabbit: { fur: "#fdf3f5", trim: "#e3bcc6", ear: "#fdf3f5", inner: "#ffb6c9", nose: "#ff8fab", noseSize: 0.06 },
  dog: { fur: "#ead2ab", trim: "#c4a074", ear: "#8a5a3a", inner: "#6b4226", nose: "#1f1612", noseSize: 0.09 },
};

/** 顔 face に着ぐるみ kind を描く (ctx は元の映像と同じ大きさの canvas) */
export function drawCostume(ctx: CanvasRenderingContext2D, face: FaceBox, kind: Costume) {
  if (kind === "none") return;
  const look = LOOKS[kind];
  const u = face.w; // 以降の長さはすべて「顔の幅」を 1 とした相対値
  const cx = face.x + face.w / 2;
  const cy = face.y + face.h / 2;

  // 顔の傾き: 左右の目を結ぶ線の角度
  let angle = 0;
  const [a, b] = face.kp;
  if (a && b && Math.abs(a.x - b.x) > 1) {
    const [l, r] = a.x < b.x ? [a, b] : [b, a];
    angle = Math.atan2(r.y - l.y, r.x - l.x);
  }

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.scale(u, u);
  ctx.lineJoin = ctx.lineCap = "round";

  // ① 耳 (フードの後ろ)
  for (const s of [-1, 1]) drawEar(ctx, kind, look, s);

  // ② フード: ふちのふわふわ + 顔の穴をあけた輪
  const HX = 0.8;
  const HY = 0.92;
  const HC = -0.08; // フードの中心の高さ
  ctx.fillStyle = look.fur;
  const FLUFF = 28;
  for (let i = 0; i < FLUFF; i++) {
    const t = (i / FLUFF) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(Math.cos(t) * HX, HC + Math.sin(t) * HY, 0.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(0, HC, HX, HY, 0, 0, Math.PI * 2);
  ctx.ellipse(0, 0.02, 0.54, 0.64, 0, 0, Math.PI * 2);
  ctx.fill("evenodd");
  // 顔の穴のふち (影っぽく濃い色 + ふわっと明るい色)
  ctx.strokeStyle = look.trim;
  ctx.lineWidth = 0.035;
  ctx.beginPath();
  ctx.ellipse(0, 0.02, 0.54, 0.64, 0, 0, Math.PI * 2);
  ctx.stroke();

  // ③ フードの模様
  drawMarkings(ctx, kind, look);

  // ④ 垂れ耳 (いぬ) はフードの前に
  if (kind === "dog") for (const s of [-1, 1]) drawFloppyEar(ctx, look, s);
  ctx.restore();

  // ⑤ 顔の上: ほっぺ・鼻・ひげ (鼻の位置に合わせる)
  const nose = face.kp[2] ?? { x: cx, y: cy };
  ctx.save();
  ctx.translate(nose.x, nose.y);
  ctx.rotate(angle);
  ctx.scale(u, u);
  ctx.lineJoin = ctx.lineCap = "round";
  drawFaceParts(ctx, kind, look);
  ctx.restore();
}

function drawEar(ctx: CanvasRenderingContext2D, kind: Exclude<Costume, "none">, look: Look, s: number) {
  ctx.fillStyle = look.ear;
  switch (kind) {
    case "cat": {
      const tri = (k: number) => {
        // 付け根 2 点と先端 (k=1 が外側の三角、小さい k は内側の三角)
        const pts = [
          [s * 0.2, -0.85],
          [s * 0.82, -0.45],
          [s * 0.7, -1.38],
        ];
        const gx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3;
        const gy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
        ctx.beginPath();
        pts.forEach(([x, y], i) => {
          const px = gx + (x - gx) * k;
          const py = gy + (y - gy) * k;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
      };
      tri(1);
      ctx.fill();
      ctx.strokeStyle = look.ear;
      ctx.lineWidth = 0.08;
      ctx.stroke();
      ctx.fillStyle = look.inner;
      tri(0.5);
      ctx.fill();
      break;
    }
    case "bear": {
      ctx.beginPath();
      ctx.arc(s * 0.6, -0.82, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = look.inner;
      ctx.beginPath();
      ctx.arc(s * 0.6, -0.82, 0.16, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "rabbit": {
      ctx.beginPath();
      ctx.ellipse(s * 0.34, -1.42, 0.18, 0.6, s * 0.14, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = look.trim;
      ctx.lineWidth = 0.02;
      ctx.stroke();
      ctx.fillStyle = look.inner;
      ctx.beginPath();
      ctx.ellipse(s * 0.34, -1.4, 0.09, 0.44, s * 0.14, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "dog":
      // 垂れ耳は drawFloppyEar で描く。ここでは頭の上の小さなふくらみだけ
      ctx.beginPath();
      ctx.arc(s * 0.5, -0.92, 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
  }
}

function drawFloppyEar(ctx: CanvasRenderingContext2D, look: Look, s: number) {
  ctx.fillStyle = look.ear;
  ctx.beginPath();
  ctx.ellipse(s * 0.84, -0.12, 0.2, 0.52, s * 0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = look.inner;
  ctx.lineWidth = 0.02;
  ctx.stroke();
}

function drawMarkings(ctx: CanvasRenderingContext2D, kind: Exclude<Costume, "none">, look: Look) {
  ctx.strokeStyle = look.trim;
  ctx.fillStyle = look.trim;
  switch (kind) {
    case "cat": {
      // おでこのしましま
      ctx.lineWidth = 0.05;
      for (const x of [-0.14, 0, 0.14]) {
        ctx.beginPath();
        ctx.moveTo(x, -0.98);
        ctx.lineTo(x * 0.8, -0.78);
        ctx.stroke();
      }
      break;
    }
    case "dog": {
      // 片側のぶち
      ctx.beginPath();
      ctx.ellipse(-0.45, -0.55, 0.2, 0.17, -0.5, 0, Math.PI * 2);
      ctx.fillStyle = look.ear;
      ctx.fill();
      break;
    }
    case "rabbit": {
      // 耳のつけねのリボンっぽい飾り
      ctx.fillStyle = "#ff8fab";
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(s * 0.12, -0.9, 0.06, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    default:
      break;
  }
}

function drawFaceParts(ctx: CanvasRenderingContext2D, kind: Exclude<Costume, "none">, look: Look) {
  // ほっぺ (うっすらピンク)
  for (const s of [-1, 1]) {
    const g = ctx.createRadialGradient(s * 0.3, 0.06, 0, s * 0.3, 0.06, 0.16);
    g.addColorStop(0, "rgba(255,120,150,0.4)");
    g.addColorStop(1, "rgba(255,120,150,0)");
    ctx.fillStyle = g;
    ctx.fillRect(s * 0.3 - 0.16, 0.06 - 0.16, 0.32, 0.32);
  }

  // ひげ (くまは無し)
  if (kind !== "bear") {
    ctx.strokeStyle = kind === "rabbit" ? "rgba(120,80,90,0.6)" : "rgba(60,40,30,0.7)";
    ctx.lineWidth = 0.012;
    for (const s of [-1, 1]) {
      for (const dy of [-0.05, 0.02, 0.09]) {
        ctx.beginPath();
        ctx.moveTo(s * 0.14, 0.02 + dy * 0.4);
        ctx.lineTo(s * 0.55, 0.02 + dy * 1.6);
        ctx.stroke();
      }
    }
  }

  // 鼻 (しずく形)
  const n = look.noseSize;
  ctx.fillStyle = look.nose;
  ctx.beginPath();
  ctx.moveTo(-n, -n * 0.5);
  ctx.quadraticCurveTo(0, -n * 0.9, n, -n * 0.5);
  ctx.quadraticCurveTo(n * 0.7, n * 0.6, 0, n * 0.9);
  ctx.quadraticCurveTo(-n * 0.7, n * 0.6, -n, -n * 0.5);
  ctx.fill();
  // 鼻のツヤ
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.beginPath();
  ctx.ellipse(-n * 0.3, -n * 0.35, n * 0.22, n * 0.14, -0.3, 0, Math.PI * 2);
  ctx.fill();
}
