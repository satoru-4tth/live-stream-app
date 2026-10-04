import type { RoomSummary } from "../shared/protocol";
import { $, elapsed } from "./common";

const grid = $("#room-grid");
const empty = $("#empty");

// ページを開いた時点の画像で固定するため、配信ごとに表示するサムネイルの版を覚えておく
// (他の人が一覧を開いてサーバー側の画像が新しくなっても、このページの表示は変えない)
const shownVersion = new Map<string, number>();
let locked = false;

function thumbnailVersion(r: RoomSummary): number | null {
  if (!r.thumbnailUpdatedAt) return null;
  if (!locked || !shownVersion.has(r.id)) shownVersion.set(r.id, r.thumbnailUpdatedAt);
  return shownVersion.get(r.id)!;
}

async function refresh() {
  try {
    const res = await fetch("/api/rooms");
    const rooms = (await res.json()) as RoomSummary[];
    render(rooms);
  } catch {
    /* 次回のポーリングで再試行 */
  }
}

function render(rooms: RoomSummary[]) {
  empty.hidden = rooms.length > 0;
  grid.replaceChildren(
    ...rooms.map((r) => {
      const a = document.createElement("a");
      a.className = "room-card";
      a.href = `/watch?room=${encodeURIComponent(r.id)}`;

      const thumb = document.createElement("div");
      thumb.className = "room-thumb";
      thumb.innerHTML = `<span class="live-badge">LIVE</span><span class="thumb-viewers">👁 <b></b></span><span class="thumb-time"></span>`;
      thumb.querySelector("b")!.textContent = String(r.viewerCount);
      thumb.querySelector(".thumb-time")!.textContent = elapsed(r.startedAt);
      // 目を引くバッジ: 始まって 10 分以内は「新着」、3 人以上が見ていれば「人気」
      const tags: string[] = [];
      if (Date.now() - r.startedAt < 10 * 60 * 1000) tags.push("🆕 新着");
      if (r.viewerCount >= 3) tags.push("🔥 人気");
      if (tags.length) {
        const t = document.createElement("span");
        t.className = "thumb-tags";
        t.textContent = tags.join(" ");
        thumb.appendChild(t);
      }
      const version = thumbnailVersion(r);
      if (version) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = `/api/rooms/${encodeURIComponent(r.id)}/thumbnail.jpg?v=${version}`;
        thumb.classList.add("has-image");
        thumb.prepend(img);
      }

      const title = document.createElement("div");
      title.className = "room-title";
      title.textContent = r.title;

      const by = document.createElement("div");
      by.className = "room-by";
      by.textContent = r.broadcasterName;

      a.append(thumb, title, by);
      return a;
    }),
  );
}

// 1. まず手元にある画像ですぐ一覧を表示
// 2. 配信者に最新の画面を依頼し、届いた頃に取り直して、その画像で固定する
refresh();
fetch("/api/rooms/refresh-thumbnails", { method: "POST" })
  .catch(() => {})
  .then(() => new Promise((r) => setTimeout(r, 1500)))
  .then(refresh)
  .finally(() => {
    locked = true;
    setInterval(refresh, 3000); // 以降は視聴者数・経過時間・新しい配信だけ更新
  });
