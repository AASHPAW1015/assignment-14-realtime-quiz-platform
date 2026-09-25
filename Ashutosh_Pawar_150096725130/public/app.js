// Shared by host.html and player.html -- body[data-page] picks which half runs.
const page = document.body.dataset.page;
const SHAPES = ["▲", "◆", "●", "■"];

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function show(viewId, allViews) {
  allViews.forEach((id) => $(id).classList.toggle("hidden", id !== viewId));
}

function toast(icon, title) {
  Swal.fire({ toast: true, position: "top", icon, title, showConfirmButton: false, timer: 2200 });
}

function setStatus(online) {
  $("status").textContent = online ? "online" : "offline";
  $("status").className = `status ${online ? "online" : "offline"}`;
}

// timer text + progress bar, both driven by the server's ticks
function renderTimer(timerEl, barEl, remaining, limit) {
  timerEl.textContent = remaining;
  timerEl.classList.toggle("low", remaining <= 5);
  barEl.style.width = `${(remaining / limit) * 100}%`;
}

function resetBar(barEl) {
  // jump back to full without animating, then let ticks animate it down
  barEl.style.transition = "none";
  barEl.style.width = "100%";
  void barEl.offsetWidth;
  barEl.style.transition = "";
}

function renderBoard(listEl, rows, myName) {
  listEl.innerHTML = "";
  rows.forEach((row) => {
    const li = document.createElement("li");
    if (row.rank === 1) li.classList.add("first");
    if (myName && row.name === myName) li.classList.add("me");
    if (row.connected === false) li.classList.add("gone");
    li.innerHTML = `<span class="rank">#${row.rank}</span>
      <span class="name">${escapeHtml(row.name)}</span>
      ${row.gained ? `<span class="gained">+${row.gained}</span>` : ""}
      <span class="score">${row.score}</span>`;
    listEl.appendChild(li);
  });
}

function renderChips(listEl, players) {
  listEl.innerHTML = "";
  players.forEach((player) => {
    const li = document.createElement("li");
    li.textContent = player.name;
    listEl.appendChild(li);
  });
}

const socket = io();
socket.on("connect", () => setStatus(true));
socket.on("disconnect", () => setStatus(false));
socket.on("quiz:error", ({ message }) => toast("error", message));
socket.on("quiz:closed", ({ message }) => {
  Swal.fire({ icon: "warning", title: message }).then(() => location.reload());
});

// ================= HOST =================
function runHost() {
  const views = ["create-view", "lobby-view", "game-view", "final-view"];
  let pin = null;
  let limit = 15;

  fetch("/api/categories")
    .then((response) => response.json())
    .then(({ categories }) => {
      $("category").innerHTML = categories
        .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
        .join("");
    });

  $("create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    socket.emit("quiz:create", { hostName: $("host-name").value, category: $("category").value });
  });

  $("start-btn").addEventListener("click", () => {
    socket.emit("quiz:start", { pin });
  });

  socket.on("quiz:created", ({ pin: newPin, category, totalQuestions }) => {
    pin = newPin;
    $("pin").textContent = pin;
    $("lobby-meta").textContent = `${category} · ${totalQuestions} questions`;
    show("lobby-view", views);
  });

  socket.on("lobby:update", ({ players }) => {
    $("player-count").textContent = players.length;
    renderChips($("lobby-list"), players);
    $("start-btn").disabled = players.length === 0;
  });

  socket.on("quiz:starting", ({ countdown }) => {
    show("game-view", views);
    $("q-text").textContent = `Get ready... first question in ${countdown}s`;
    $("q-options").innerHTML = "";
  });

  socket.on("question:start", ({ questionIndex, totalQuestions, question, options, timeLimitSeconds }) => {
    limit = timeLimitSeconds;
    $("q-count").textContent = `Question ${questionIndex} / ${totalQuestions}`;
    $("answered").textContent = "0 answered";
    $("q-text").textContent = question;
    $("explanation").classList.add("hidden");
    $("q-options").innerHTML = options
      .map((text, i) => `<div class="option c${i}"><span class="shape">${SHAPES[i]}</span>${escapeHtml(text)}</div>`)
      .join("");
    resetBar($("bar-fill"));
    renderTimer($("timer"), $("bar-fill"), limit, limit);
  });

  socket.on("question:tick", ({ timeRemaining }) => {
    renderTimer($("timer"), $("bar-fill"), timeRemaining, limit);
  });

  socket.on("answer:progress", ({ answered, total }) => {
    $("answered").textContent = `${answered} / ${total} answered`;
  });

  socket.on("question:time_up", ({ correctOption, explanation, answeredCount }) => {
    renderTimer($("timer"), $("bar-fill"), 0, limit);
    $("answered").textContent = `${answeredCount} answered`;
    [...$("q-options").children].forEach((node, i) => {
      node.classList.add(i === correctOption ? "correct" : "dim");
    });
    $("explanation").textContent = explanation;
    $("explanation").classList.remove("hidden");
  });

  socket.on("leaderboard:update", ({ leaderboard }) => {
    renderBoard($("leaderboard"), leaderboard);
  });

  socket.on("quiz:ended", ({ winner, finalRanks }) => {
    $("winner").textContent = winner ? `🏆 ${winner.name} · ${winner.score}` : "No players";
    renderBoard($("final-board"), finalRanks);
    show("final-view", views);
  });
}

// ================= PLAYER =================
function runPlayer() {
  const views = ["join-view", "wait-view", "answer-view", "p-final-view"];
  let pin = null;
  let myName = null;
  let limit = 15;
  let questionShownAt = 0;
  let answered = false;
  let lastExplanation = "";

  const params = new URLSearchParams(location.search);
  if (params.get("pin")) $("pin-input").value = params.get("pin");

  function waitScreen(title, text) {
    $("wait-title").innerHTML = title;
    $("wait-text").textContent = text;
    show("wait-view", views);
  }

  $("join-form").addEventListener("submit", (event) => {
    event.preventDefault();
    socket.emit("quiz:join", { pin: $("pin-input").value.trim(), playerName: $("player-name").value.trim() });
  });

  socket.on("quiz:joined", ({ pin: joinedPin, playerName, hostName, category }) => {
    pin = joinedPin;
    myName = playerName;
    $("player-title").textContent = playerName;
    $("score-chip").classList.remove("hidden");
    waitScreen("You're in!", `${hostName}'s ${category} quiz. Waiting for the host to start...`);
  });

  socket.on("lobby:update", ({ players }) => {
    renderChips($("player-lobby"), players);
  });

  socket.on("quiz:starting", ({ countdown }) => {
    $("player-lobby").innerHTML = "";
    waitScreen("Get ready!", `First question in ${countdown} seconds`);
  });

  socket.on("question:start", ({ questionIndex, totalQuestions, question, options, timeLimitSeconds }) => {
    limit = timeLimitSeconds;
    answered = false;
    questionShownAt = Date.now();
    $("p-count").textContent = `Question ${questionIndex} / ${totalQuestions}`;
    $("p-question").textContent = question;
    $("pad").innerHTML = "";

    options.forEach((text, i) => {
      const button = document.createElement("button");
      button.className = `option c${i}`;
      button.innerHTML = `<span class="shape">${SHAPES[i]}</span>${escapeHtml(text)}`;
      button.addEventListener("click", () => submitAnswer(i));
      $("pad").appendChild(button);
    });

    resetBar($("p-bar-fill"));
    renderTimer($("p-timer"), $("p-bar-fill"), limit, limit);
    show("answer-view", views);
  });

  function submitAnswer(index) {
    if (answered) return;
    answered = true;
    [...$("pad").children].forEach((button, i) => {
      button.disabled = true;
      button.classList.add(i === index ? "picked" : "dim");
    });
    // timeTakenMs is informational; the server scores with its own clock
    socket.emit("answer:submit", { pin, selectedOption: index, timeTakenMs: Date.now() - questionShownAt });
  }

  socket.on("question:tick", ({ timeRemaining }) => {
    renderTimer($("p-timer"), $("p-bar-fill"), timeRemaining, limit);
    if (timeRemaining === 0) {
      [...$("pad").children].forEach((button) => (button.disabled = true));
    }
  });

  socket.on("answer:locked", ({ timeTakenMs }) => {
    waitScreen("Answer locked in", `Answered in ${(timeTakenMs / 1000).toFixed(1)}s. Waiting for the others...`);
  });

  socket.on("answer:rejected", ({ reason }) => {
    toast("error", reason);
  });

  socket.on("answer:result", ({ answered: didAnswer, correct, points, score, rank }) => {
    $("score-chip").textContent = `${score} pts`;
    if (!didAnswer) {
      waitScreen(`<span class="result-bad">Time's up!</span>`, `No answer. You are #${rank} with ${score} points. ${lastExplanation}`);
    } else if (correct) {
      waitScreen(`<span class="result-good">Correct! +${points}</span>`, `You are #${rank} with ${score} points. ${lastExplanation}`);
    } else {
      waitScreen(`<span class="result-bad">Wrong answer</span>`, `You are #${rank} with ${score} points. ${lastExplanation}`);
    }
  });

  // time_up always lands before answer:result, so keep it for that screen
  socket.on("question:time_up", ({ explanation }) => {
    lastExplanation = explanation;
  });

  socket.on("quiz:ended", ({ winner, finalRanks }) => {
    const me = finalRanks.find((row) => row.name === myName);
    $("p-final-title").textContent = winner && winner.name === myName ? "🏆 You won!" : `Winner: ${winner ? winner.name : "-"}`;
    $("p-final-text").textContent = me ? `You finished #${me.rank} with ${me.score} points (${me.correct} correct).` : "";
    renderBoard($("p-final-board"), finalRanks, myName);
    show("p-final-view", views);
  });
}

if (page === "host") runHost();
if (page === "player") runPlayer();
