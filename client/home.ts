import type { RoomSummary } from "../shared/protocol";
import { $, elapsed } from "./common";

const grid = $("#room-grid");
const empty = $("#empty");

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
      if (r.thumbnailUpdatedAt) {
        const img = document.createElement("img");
        img.alt = "";
        img.src = `/api/rooms/${encodeURIComponent(r.id)}/thumbnail.jpg?v=${r.thumbnailUpdatedAt}`;
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

refresh();
setInterval(refresh, 3000);
