const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Render / HTTPS mic-camera permission headers
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(self)");
  res.setHeader("Feature-Policy", "microphone 'self'; camera 'self'");
  next();
});

app.use(express.static(path.join(__dirname, "public")));

const users = new Map();
const callHistory = [];

app.get("/call-history", (req, res) => {
  res.json(callHistory.slice(-50).reverse());
});

function history(type, fromName, toName, mode) {
  callHistory.push({
    type,
    mode: mode || "voice",
    fromName: fromName || "Unknown",
    toName: toName || "Unknown",
    time: new Date().toLocaleString()
  });
}

function listUsers() {
  return Array.from(users.entries()).map(([socketId, u]) => ({
    socketId,
    name: u.name,
    photo: u.photo || "",
    busy: u.busy
  }));
}

function sendUsers() {
  io.emit("users:update", listUsers());
}

io.on("connection", socket => {
  console.log("Connected:", socket.id);

  socket.on("user:join", data => {
    users.set(socket.id, {
      name: String(data?.name || data || "Unknown"),
      photo: data?.photo || "",
      busy: false
    });

    sendUsers();
  });

  socket.on("call:request", ({ to, offer, mode }) => {
    const caller = users.get(socket.id);
    const receiver = users.get(to);

    if (!caller) return socket.emit("call:error", "Join first");
    if (!receiver) return socket.emit("call:error", "User offline");
    if (receiver.busy) return socket.emit("call:error", "User is busy");

    caller.busy = true;
    receiver.busy = true;
    sendUsers();

    history("Ringing", caller.name, receiver.name, mode);

    socket.to(to).emit("call:incoming", {
      from: socket.id,
      callerName: caller.name,
      callerPhoto: caller.photo,
      offer,
      mode
    });
  });

  socket.on("call:accept", ({ to, answer, mode }) => {
    const me = users.get(socket.id);
    const other = users.get(to);

    history("Answered", other?.name, me?.name, mode);

    socket.to(to).emit("call:accepted", {
      from: socket.id,
      answer,
      mode
    });
  });

  socket.on("call:reject", ({ to, mode }) => {
    const me = users.get(socket.id);
    const other = users.get(to);

    if (me) me.busy = false;
    if (other) other.busy = false;

    history("Rejected / Missed", other?.name, me?.name, mode);
    sendUsers();

    socket.to(to).emit("call:rejected", {
      from: socket.id
    });
  });

  socket.on("call:end", ({ to, mode }) => {
    const me = users.get(socket.id);
    const other = users.get(to);

    if (me) me.busy = false;
    if (other) other.busy = false;

    history("Ended", me?.name, other?.name, mode);
    sendUsers();

    if (to) {
      socket.to(to).emit("call:ended", {
        from: socket.id
      });
    }
  });

  socket.on("webrtc:ice", ({ to, candidate }) => {
    socket.to(to).emit("webrtc:ice", {
      from: socket.id,
      candidate
    });
  });

  socket.on("disconnect", () => {
    users.delete(socket.id);
    sendUsers();
    console.log("Disconnected:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
});