// Authoritative game loop. The server owns the clock: it sends each question,
// ticks the countdown, stamps when answers arrive, scores them and reveals
// the correct option. Clients only render what they are told.
const QUESTION_TIME_MS = 15000;
const REVEAL_DELAY_MS = 5000; // leaderboard stays up this long between rounds
const GRACE_MS = 300; // network slack for an answer sent right at 0

// Score = 500 base + up to 500 speed bonus. Max 1000 per question.
function calculateScore(isCorrect, timeTakenMs, totalTimeLimitMs = QUESTION_TIME_MS) {
  if (!isCorrect) return 0;

  const timeRemaining = Math.max(0, totalTimeLimitMs - timeTakenMs);
  const speedBonus = Math.round((timeRemaining / totalTimeLimitMs) * 500);
  const baseScore = 500;

  return baseScore + speedBonus;
}

// Highest score first. Equal scores share a rank (1, 2, 2, 4).
function buildLeaderboard(game) {
  const sorted = Object.values(game.players).sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name),
  );

  let rank = 0;
  let previous = null;
  return sorted.map((player, index) => {
    if (player.score !== previous) {
      rank = index + 1;
      previous = player.score;
    }
    return {
      rank,
      name: player.name,
      score: player.score,
      gained: player.lastPoints,
      correct: player.correctCount,
      connected: player.connected,
    };
  });
}

function clearTimers(game) {
  clearInterval(game.tickInterval);
  clearTimeout(game.deadline);
  clearTimeout(game.nextTimer);
}

function connectedPlayerIds(game) {
  return Object.keys(game.players).filter((id) => game.players[id].connected);
}

function sendQuestion(io, game) {
  game.index += 1;
  if (game.index >= game.questions.length) {
    return endGame(io, game);
  }

  const question = game.questions[game.index];
  game.state = "question";
  game.answers = {};
  game.questionStartedAt = Date.now();
  game.timeRemaining = QUESTION_TIME_MS / 1000;
  Object.values(game.players).forEach((player) => {
    player.lastPoints = 0;
  });

  // correctOption and explanation are NOT sent -- nothing to peek at in devtools
  io.to(game.roomId).emit("question:start", {
    questionIndex: game.index + 1,
    totalQuestions: game.questions.length,
    question: question.question,
    options: question.options,
    timeLimitSeconds: QUESTION_TIME_MS / 1000,
  });

  // one tick per second so every screen shows the same server-side number
  game.tickInterval = setInterval(() => {
    game.timeRemaining = Math.max(0, game.timeRemaining - 1);
    io.to(game.roomId).emit("question:tick", { timeRemaining: game.timeRemaining });
  }, 1000);
  game.deadline = setTimeout(() => timeUp(io, game), QUESTION_TIME_MS);
}

function timeUp(io, game) {
  if (game.state !== "question") return;
  clearTimers(game);
  game.state = "reveal";

  const question = game.questions[game.index];
  io.to(game.roomId).emit("question:time_up", {
    questionIndex: game.index + 1,
    correctOption: question.correctOption,
    explanation: question.explanation,
    answeredCount: Object.keys(game.answers).length,
  });

  const leaderboard = buildLeaderboard(game);
  io.to(game.roomId).emit("leaderboard:update", { leaderboard });

  // each player also gets their own result for this round
  Object.entries(game.players).forEach(([id, player]) => {
    const answer = game.answers[id];
    io.to(id).emit("answer:result", {
      answered: Boolean(answer),
      correct: answer ? answer.correct : false,
      points: player.lastPoints,
      score: player.score,
      rank: leaderboard.find((row) => row.name === player.name).rank,
    });
  });

  game.nextTimer = setTimeout(() => sendQuestion(io, game), REVEAL_DELAY_MS);
}

function endGame(io, game) {
  clearTimers(game);
  game.state = "ended";

  const finalRanks = buildLeaderboard(game);
  const top = finalRanks[0];
  io.to(game.roomId).emit("quiz:ended", {
    winner: top ? { name: top.name, score: top.score } : null,
    finalRanks,
  });
}

function startGame(io, game) {
  game.state = "starting";
  game.index = -1;
  io.to(game.roomId).emit("quiz:starting", { countdown: 3, totalQuestions: game.questions.length });
  game.nextTimer = setTimeout(() => sendQuestion(io, game), 3000);
}

// A player dropped mid-round: if everyone still here has answered, reveal now.
function checkAllAnswered(io, game) {
  if (game.state !== "question") return;
  const ids = connectedPlayerIds(game);
  if (ids.length > 0 && ids.every((id) => game.answers[id])) {
    timeUp(io, game);
  }
}

function registerGameHandlers(io, socket, games) {
  socket.on("answer:submit", ({ pin, selectedOption, timeTakenMs } = {}) => {
    const game = games[pin];
    const player = game && game.players[socket.id];
    if (!player) {
      return socket.emit("answer:rejected", { reason: "You are not in this quiz" });
    }

    // Anti-cheat: the server's own clock decides, not the client's timeTakenMs.
    // Anything after the deadline (plus a little network slack) is rejected.
    const elapsed = Date.now() - game.questionStartedAt;
    if (game.state !== "question" || elapsed > QUESTION_TIME_MS + GRACE_MS) {
      return socket.emit("answer:rejected", { reason: "Time is up for this question" });
    }
    if (game.answers[socket.id]) {
      return socket.emit("answer:rejected", { reason: "You already answered this question" });
    }

    const question = game.questions[game.index];
    const choice = Number(selectedOption);
    if (!Number.isInteger(choice) || choice < 0 || choice >= question.options.length) {
      return socket.emit("answer:rejected", { reason: "Invalid option" });
    }

    const timeTaken = Math.min(elapsed, QUESTION_TIME_MS);
    const correct = choice === question.correctOption;
    const points = calculateScore(correct, timeTaken);

    game.answers[socket.id] = { selectedOption: choice, timeTaken, correct, clientTimeMs: timeTakenMs };
    player.lastPoints = points;
    player.score += points;
    if (correct) player.correctCount += 1;

    // lock-in only; right/wrong is revealed to everyone at time up
    socket.emit("answer:locked", { selectedOption: choice, timeTakenMs: timeTaken });
    io.to(game.hostId).emit("answer:progress", {
      answered: Object.keys(game.answers).length,
      total: connectedPlayerIds(game).length,
    });

    checkAllAnswered(io, game);
  });
}

module.exports = {
  QUESTION_TIME_MS,
  calculateScore,
  buildLeaderboard,
  clearTimers,
  startGame,
  checkAllAnswered,
  registerGameHandlers,
};
