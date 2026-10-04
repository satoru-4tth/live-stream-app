// サーバーとクライアントで共有する WebSocket メッセージの型定義

export interface RoomSummary {
  id: string;
  title: string;
  broadcasterName: string;
  viewerCount: number;
  startedAt: number;
  /** サムネイル最終更新時刻 (未設定なら null)。画像は /api/rooms/:id/thumbnail.jpg */
  thumbnailUpdatedAt: number | null;
}

/** WebRTC のシグナリングデータ (SDP または ICE 候補) */
export type SignalData =
  | { sdp: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit };

/** クライアント → サーバー */
export type ClientMessage =
  | { type: "create-room"; title: string; name: string }
  | { type: "join-room"; roomId: string; name: string }
  | { type: "signal"; to: string; data: SignalData }
  | { type: "chat"; text: string }
  | { type: "set-name"; name: string }
  | { type: "thumbnail"; dataUrl: string }
  | { type: "end-room" };

/** サーバー → クライアント */
export type ServerMessage =
  | { type: "room-created"; roomId: string; clientId: string }
  | { type: "joined"; roomId: string; clientId: string; title: string; broadcasterName: string; broadcasterId: string }
  | { type: "viewer-joined"; viewerId: string }
  | { type: "viewer-left"; viewerId: string }
  | { type: "signal"; from: string; data: SignalData }
  | { type: "chat"; name: string; text: string; ts: number; isBroadcaster: boolean }
  | { type: "system"; text: string }
  | { type: "viewer-count"; count: number }
  | { type: "request-thumbnail" }
  | { type: "room-ended" }
  | { type: "error"; message: string };

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  // 本番では TURN サーバーを追加してください (NAT 越えできない環境向け)
  // { urls: "turn:your-turn.example.com:3478", username: "user", credential: "pass" },
];
