import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { ICE_SERVERS, REACTIONS, TIP_AMOUNTS, type ClientMessage, type RoomSummary, type ServerMessage } from "../shared/protocol.js";
import { paymentProvider } from "./payments.js";

const PORT = Number(process.env.PORT ?? 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- データ構造 ----------
interface Client {
  id: string;
  ws: WebSocket;
  name: string;
  roomId?: string;
  role?: "broadcaster" | "viewer";
  lastReactionAt?: number;
}

interface Room {
  id: string;
  title: string;
  broadcaster: Client;
  viewers: Map<string, Client>;
  startedAt: number;
  thumbnail?: { data: Buffer; updatedAt: number };
  thumbnailRequestedAt?: number;
  tipTotal: number;
  /** 視聴者ごとの投げ銭合計 (サポーターランキング用。キーは接続 ID) */
  supporters: Map<string, { name: string; total: number }>;
}

const MAX_THUMBNAIL_BYTES = 200 * 1024;

const clients = new Map<string, Client>();
const rooms = new Map<string, Room>();

// ---------- HTTP ----------
const app = express();
app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));

// WebRTC の接続先候補。STUN に加え、環境変数で TURN を設定できる
// (スマホのモバイル回線など、直接つなげないネットワークでは TURN 経由でないと映像が届かない)
//   TURN_URLS=turn:example.com:3478,turns:example.com:443?transport=tcp
//   TURN_USERNAME=... / TURN_CREDENTIAL=...
function iceServers(): RTCIceServer[] {
  const urls = (process.env.TURN_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const { TURN_USERNAME: username, TURN_CREDENTIAL: credential } = process.env;
  if (urls.length === 0 || !username || !credential) return ICE_SERVERS;
  return [...ICE_SERVERS, { urls, username, credential }];
}

app.get("/api/ice-servers", (_req, res) => {
  res.set("Cache-Control", "no-store").json(iceServers());
});

app.get("/api/rooms", (_req, res) => {
  const list: RoomSummary[] = [...rooms.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(summarize);
  res.json(list);
});

app.get("/api/rooms/:id", (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: "not found" });
  res.json(summarize(room));
});

// 配信中の映像のサムネイル (配信者が定期的に送ってくる JPEG)
app.get("/api/rooms/:id/thumbnail.jpg", (req, res) => {
  const thumb = rooms.get(req.params.id)?.thumbnail;
  if (!thumb) return res.status(404).end();
  res.type("jpeg").set("Cache-Control", "public, max-age=300").send(thumb.data);
});

// 一覧ページを開いたときに呼ばれる: 各配信者に「今の画面を 1 枚送って」と依頼する
// (同じ配信への依頼は 5 秒に 1 回まで。アクセスが集中しても配信者の負担にならないように)
const THUMBNAIL_REQUEST_INTERVAL = 5000;
app.post("/api/rooms/refresh-thumbnails", (_req, res) => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - (room.thumbnailRequestedAt ?? 0) < THUMBNAIL_REQUEST_INTERVAL) continue;
    room.thumbnailRequestedAt = now;
    send(room.broadcaster, { type: "request-thumbnail" });
  }
  res.status(204).end();
});

const server = createServer(app);

// ---------- WebSocket (シグナリング / チャット) ----------
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 512 * 1024 });

wss.on("connection", (ws) => {
  const client: Client = { id: randomUUID(), ws, name: "名無し" };
  clients.set(client.id, client);

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(client, { type: "error", message: "不正なメッセージです" });
    }
    handleMessage(client, msg);
  });

  ws.on("close", () => {
    leave(client);
    clients.delete(client.id);
  });
});

function handleMessage(client: Client, msg: ClientMessage) {
  switch (msg.type) {
    case "create-room": {
      if (client.roomId) return send(client, { type: "error", message: "既にルームに参加しています" });
      const room: Room = {
        id: randomUUID().slice(0, 8),
        title: clip(msg.title, 60) || "無題の配信",
        broadcaster: client,
        viewers: new Map(),
        startedAt: Date.now(),
        tipTotal: 0,
        supporters: new Map(),
      };
      client.name = clip(msg.name, 30) || "配信者";
      client.roomId = room.id;
      client.role = "broadcaster";
      rooms.set(room.id, room);
      send(client, { type: "room-created", roomId: room.id, clientId: client.id });
      console.log(`[room] 作成 ${room.id} "${room.title}" by ${client.name}`);
      break;
    }

    case "join-room": {
      const room = rooms.get(msg.roomId);
      if (!room) return send(client, { type: "error", message: "配信が見つかりません（終了した可能性があります）" });
      if (client.roomId) return send(client, { type: "error", message: "既にルームに参加しています" });
      client.name = clip(msg.name, 30) || `視聴者${Math.floor(Math.random() * 9000 + 1000)}`;
      client.roomId = room.id;
      client.role = "viewer";
      room.viewers.set(client.id, client);
      send(client, {
        type: "joined",
        roomId: room.id,
        clientId: client.id,
        title: room.title,
        broadcasterName: room.broadcaster.name,
        broadcasterId: room.broadcaster.id,
      });
      // 配信者に通知 → 配信者側から offer を送る
      send(room.broadcaster, { type: "viewer-joined", viewerId: client.id });
      send(client, { type: "tip-total", total: room.tipTotal });
      send(client, { type: "supporters", list: topSupporters(room) });
      broadcastToRoom(room, { type: "system", text: `${client.name} さんが入室しました` });
      broadcastViewerCount(room);
      break;
    }

    case "signal": {
      // 同じルーム内の相手にだけ中継する
      const target = clients.get(msg.to);
      if (!target || !client.roomId || target.roomId !== client.roomId) return;
      send(target, { type: "signal", from: client.id, data: msg.data });
      break;
    }

    case "chat": {
      const room = client.roomId ? rooms.get(client.roomId) : undefined;
      const text = clip(msg.text, 200);
      if (!room || !text) return;
      broadcastToRoom(room, {
        type: "chat",
        name: client.name,
        text,
        ts: Date.now(),
        isBroadcaster: client.role === "broadcaster",
      });
      break;
    }

    case "tip": {
      // 視聴者のみ。決められた金額以外は受け付けない
      const room = client.roomId ? rooms.get(client.roomId) : undefined;
      if (!room || client.role !== "viewer") return;
      if (!(TIP_AMOUNTS as readonly number[]).includes(msg.amount)) {
        return send(client, { type: "error", message: "不正な金額です" });
      }
      const amount = msg.amount;
      const viewerName = client.name;
      // 決済の成否を待ってから反映する (疑似決済は即成功。本番では Stripe 等に差し替え)
      paymentProvider.charge({ roomId: room.id, viewerId: client.id, amount }).then(
        () => {
          if (!rooms.has(room.id)) return;
          room.tipTotal += amount;
          const prev = room.supporters.get(client.id);
          room.supporters.set(client.id, { name: viewerName, total: (prev?.total ?? 0) + amount });
          broadcastToRoom(room, { type: "tip", name: viewerName, amount, ts: Date.now() });
          broadcastToRoom(room, { type: "tip-total", total: room.tipTotal });
          broadcastToRoom(room, { type: "supporters", list: topSupporters(room) });
          console.log(`[tip] ${room.id} ${viewerName} ¥${amount}`);
        },
        (e) => send(client, { type: "error", message: `決済に失敗しました: ${(e as Error).message}` }),
      );
      break;
    }

    case "reaction": {
      // ルーム内の誰でも送れる。決められた絵文字だけ、1 人あたり 0.15 秒に 1 回まで (連打で他の人の画面が埋まらないように)
      const room = client.roomId ? rooms.get(client.roomId) : undefined;
      if (!room || !(REACTIONS as readonly string[]).includes(msg.emoji)) return;
      const now = Date.now();
      if (now - (client.lastReactionAt ?? 0) < 150) return;
      client.lastReactionAt = now;
      broadcastToRoom(room, { type: "reaction", emoji: msg.emoji });
      break;
    }

    case "set-name": {
      const name = clip(msg.name, 30);
      if (name) client.name = name;
      break;
    }

    case "thumbnail": {
      // 配信者本人のみ。JPEG の data URL だけ受け付ける
      const room = client.roomId ? rooms.get(client.roomId) : undefined;
      const prefix = "data:image/jpeg;base64,";
      if (!room || client.role !== "broadcaster" || typeof msg.dataUrl !== "string" || !msg.dataUrl.startsWith(prefix)) return;
      const data = Buffer.from(msg.dataUrl.slice(prefix.length), "base64");
      if (data.length === 0 || data.length > MAX_THUMBNAIL_BYTES) return;
      room.thumbnail = { data, updatedAt: Date.now() };
      break;
    }

    case "end-room":
      if (client.role === "broadcaster") leave(client);
      break;
  }
}

function leave(client: Client) {
  const room = client.roomId ? rooms.get(client.roomId) : undefined;
  if (!room) return;

  if (client.role === "broadcaster") {
    for (const v of room.viewers.values()) {
      send(v, { type: "room-ended" });
      v.roomId = undefined;
      v.role = undefined;
    }
    rooms.delete(room.id);
    console.log(`[room] 終了 ${room.id}`);
  } else {
    room.viewers.delete(client.id);
    send(room.broadcaster, { type: "viewer-left", viewerId: client.id });
    broadcastToRoom(room, { type: "system", text: `${client.name} さんが退室しました` });
    broadcastViewerCount(room);
  }
  client.roomId = undefined;
  client.role = undefined;
}

// ---------- ユーティリティ ----------
function send(client: Client, msg: ServerMessage) {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
}

function broadcastToRoom(room: Room, msg: ServerMessage) {
  send(room.broadcaster, msg);
  for (const v of room.viewers.values()) send(v, msg);
}

function broadcastViewerCount(room: Room) {
  broadcastToRoom(room, { type: "viewer-count", count: room.viewers.size });
}

/** 投げ銭の多い順に上位 3 人 */
function topSupporters(room: Room) {
  return [...room.supporters.values()].sort((a, b) => b.total - a.total).slice(0, 3);
}

function summarize(room: Room): RoomSummary {
  return {
    id: room.id,
    title: room.title,
    broadcasterName: room.broadcaster.name,
    viewerCount: room.viewers.size,
    startedAt: room.startedAt,
    thumbnailUpdatedAt: room.thumbnail?.updatedAt ?? null,
  };
}

function clip(s: unknown, max: number): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

server.listen(PORT, () => {
  console.log(`🎥 ライブ配信サーバー起動: http://localhost:${PORT}`);
});
