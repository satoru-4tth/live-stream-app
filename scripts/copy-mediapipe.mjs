// 顔検出 (美顔補正) の WASM を node_modules から public/mediapipe/wasm/ にコピーする (npm run build の一部)
import { cpSync, mkdirSync } from "node:fs";

const from = new URL("../node_modules/@mediapipe/tasks-vision/wasm/", import.meta.url);
const to = new URL("../public/mediapipe/wasm/", import.meta.url);
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log("copied mediapipe wasm -> public/mediapipe/wasm");
