import { io } from "socket.io-client";
const socket = io("http://localhost:80", { transports: ["websocket"] });
socket.on("connect", () => {
  console.log("connected, emitting kill_all...");
  socket.emit("kill_all");
});
socket.on("status", (msg) => console.log("STATUS:", msg));
setTimeout(() => process.exit(0), 8000);
