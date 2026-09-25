const questionBank = require("../data/questions.json");
const { startGame, clearTimers, checkAllAnswered } = require("./gameEngine");

const QUESTIONS_PER_GAME = 5;
const MAX_PLAYERS = 50;

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pickQuestions(category) {
  const wanted = String(category ?? "").toLowerCase();
  const matching = questionBank.filter((q) => q.category.toLowerCase() === wanted);
  // unknown category or "Mixed" -> draw from the whole bank
  return shuffle(matching.length ? matching : questionBank).slice(0, QUESTIONS_PER_GAME);
}

// 4-digit PIN not already used by a live game
function generatePin(games) {
  let pin;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (games[pin]);
  return pin;
}

function lobbyPlayers(game) {
  return Object.values(game.players)
    .filter((player) => player.connected)
    .map((player) => ({ name: player.name, score: player.score }));
}

function registerLobbyHandlers(io, socket, games) {
  socket.on("quiz:create", ({ hostName, category } = {}) => {
    const pin = generatePin(games);
    const roomId = `quiz_${pin}`;

    games[pin] = {
      pin,
      roomId,
      hostId: socket.id,
      hostName: String(hostName ?? "Host").trim().slice(0, 30) || "Host",
      category: category || "Mixed",
      questions: pickQuestions(category),
      players: {}, // socketId -> { name, score, correctCount, lastPoints, connected }
      answers: {},
      state: "lobby", // lobby -> starting -> question <-> reveal -> ended
      index: -1,
    };

    socket.data.pin = pin;
    socket.data.role = "host";
    socket.join(roomId);
    socket.emit("quiz:created", { pin, roomId, category: games[pin].category, totalQuestions: games[pin].questions.length });
  });

  socket.on("quiz:join", ({ pin, playerName } = {}) => {
    const code = String(pin ?? "").trim();
    const name = String(playerName ?? "").trim().slice(0, 20);
    const game = games[code];

    if (!name) return socket.emit("quiz:error", { message: "Enter your name" });
    if (!game) return socket.emit("quiz:error", { message: "No quiz found with that PIN" });
    if (game.state !== "lobby") return socket.emit("quiz:error", { message: "This quiz has already started" });
    if (Object.keys(game.players).length >= MAX_PLAYERS) {
      return socket.emit("quiz:error", { message: "Lobby is full" });
    }
    const taken = Object.values(game.players).some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return socket.emit("quiz:error", { message: "That name is taken in this lobby" });

    game.players[socket.id] = { name, score: 0, correctCount: 0, lastPoints: 0, connected: true };
    socket.data.pin = code;
    socket.data.role = "player";
    socket.join(game.roomId);

    socket.emit("quiz:joined", { pin: code, playerName: name, hostName: game.hostName, category: game.category });
    io.to(game.roomId).emit("lobby:update", { players: lobbyPlayers(game) });
  });

  socket.on("quiz:start", ({ pin } = {}) => {
    const game = games[pin];
    if (!game || game.hostId !== socket.id) {
      return socket.emit("quiz:error", { message: "Only the host can start this quiz" });
    }
    if (game.state !== "lobby") return;
    if (lobbyPlayers(game).length === 0) {
      return socket.emit("quiz:error", { message: "Wait for at least one player to join" });
    }
    startGame(io, game);
  });

  socket.on("disconnect", () => {
    const game = games[socket.data.pin];
    if (!game) return;

    if (socket.data.role === "host") {
      // no host, no game: stop the clock and send everyone home
      clearTimers(game);
      io.to(game.roomId).emit("quiz:closed", { message: "The host left, quiz closed" });
      delete games[game.pin];
      return;
    }

    const player = game.players[socket.id];
    if (!player) return;

    if (game.state === "lobby") {
      delete game.players[socket.id];
    } else {
      // keep their score on the board, just mark them gone
      player.connected = false;
      checkAllAnswered(io, game);
    }
    io.to(game.roomId).emit("lobby:update", { players: lobbyPlayers(game) });
  });
}

module.exports = registerLobbyHandlers;
