import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, RoomSummary, ServerMessage } from "../shared/protocol.js";

const PORT = Number(process.env.PORT ?? 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- データ構造 ----------
interface Client {
  id: string;
  ws: WebSocket;
  name: string;
  roomId?: string;
  role?: "broadcaster" | "viewer";
}

interface Room {
  id: string;
  title: string;
  broadcaster: Client;
  viewers: Map<string, Client>;
  startedAt: number;
}

const clients = new Map<string, Client>();
const rooms = new Map<string, Room>();

// ---------- HTTP ----------
const app = express();
app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));

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

const server = createServer(app);

// ---------- WebSocket (シグナリング / チャット) ----------
const wss = new WebSocketServer({ server, path: "/ws" });

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

    case "set-name": {
      const name = clip(msg.name, 30);
      if (name) client.name = name;
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

function summarize(room: Room): RoomSummary {
  return {
    id: room.id,
    title: room.title,
    broadcasterName: room.broadcaster.name,
    viewerCount: room.viewers.size,
    startedAt: room.startedAt,
  };
}

function clip(s: unknown, max: number): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

server.listen(PORT, () => {
  console.log(`🎥 ライブ配信サーバー起動: http://localhost:${PORT}`);
});
