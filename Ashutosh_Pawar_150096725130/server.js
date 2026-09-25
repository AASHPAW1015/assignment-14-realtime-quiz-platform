require("dotenv").config({ quiet: true });

const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const registerLobbyHandlers = require("./sockets/lobbyHandler");
const { registerGameHandlers } = require("./sockets/gameEngine");
const questionBank = require("./data/questions.json");

const app = express();

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// categories for the host's dropdown
app.get("/api/categories", (request, response) => {
  const categories = [...new Set(questionBank.map((q) => q.category))];
  response.status(200).json({ categories: [...categories, "Mixed"] });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// pin -> game state (see lobbyHandler for the shape)
const games = {};

io.on("connection", (socket) => {
  console.log(`socket connected: ${socket.id}`);
  registerLobbyHandlers(io, socket, games);
  registerGameHandlers(io, socket, games);
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`quiz server is running on port ${PORT}!!`);
});
