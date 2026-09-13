import { io } from "socket.io-client";
const socket = io("http://localhost:80", { transports: ["websocket"] });
socket.on("connect", () => {
  console.log("connected, emitting launch...");
  socket.emit("launch", { mod: "cpma", mode: "ffa", mapName: "q3dm1" });
});
socket.on("status", (msg) => console.log("STATUS:", msg));
socket.on("map_found", (info) => console.log("MAP_FOUND:", JSON.stringify(info)));
socket.on("map_search_fallback", (info) => console.log("FALLBACK:", JSON.stringify(info)));
setTimeout(() => process.exit(0), 20000);
