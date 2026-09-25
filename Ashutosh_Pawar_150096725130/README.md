# Real-Time Multiplayer Quiz Battle

Assignment 14 - Ashutosh Pawar (150096725130)

Kahoot-style live trivia built with Express and Socket.io. A host creates a
quiz and gets a 4-digit PIN, players join the lobby with that PIN, and the host
starts the battle. The server is the only authority: it sends each question
(without the answer), runs the 15-second countdown and ticks it to every
screen, timestamps each answer with its own clock, rejects anything late or
repeated, scores correct answers by speed, then reveals the right option and
pushes a sorted leaderboard after every round. The host screen shows the
question, live answer count and rankings; the player screen is a
mobile-friendly 4-colour answer pad.


## Live demo

https://assignment-14-realtime-quiz-platform-7js5.onrender.com

Open `/host.html` in one tab to create a quiz and get a PIN, then `/player.html`
in other tabs (or on phones) to join with it. The app runs as one Render web
service on the free tier (which supports WebSockets): the first visit after a
period of inactivity can take up to a minute, and game state lives in memory,
so it resets whenever the server restarts. Deployed with root directory
`Ashutosh_Pawar_150096725130`, build `npm install`, start `npm start`; Render
provides `PORT`.

## Tech stack

- Node.js, Express 5
- Socket.io (server + browser client)
- dotenv, cors
- HTML + CSS + plain JS + SweetAlert2 for the frontend

## Project structure

```text
Ashutosh_Pawar_150096725130/
├── data/
│   └── questions.json    # question bank (Tech, Science, General)
├── public/
│   ├── index.html        # portal: host or player
│   ├── host.html         # create quiz, PIN lobby, live question + leaderboard
│   ├── player.html       # join form + 4-colour answer pad
│   ├── app.js            # socket handlers for both pages (body[data-page])
│   └── style.css
├── sockets/
│   ├── gameEngine.js     # timers, answer validation, scoring, leaderboard
│   └── lobbyHandler.js   # PIN generation, join, start, disconnects
├── .env.example
├── .gitignore
├── package.json
├── server.js             # Express static server, /api/categories, Socket.io
└── README.md
```

## Setup

```bash
npm install
cp .env.example .env
npm run dev      # or: npm start
```

- Host: `http://localhost:5000/host.html`
- Players: `http://localhost:5000/player.html` (or `?pin=8421` to prefill)

## Environment variables

| Variable | Required | Notes            |
| -------- | :------: | ---------------- |
| `PORT`   |    no    | defaults to 5000 |

## Game flow

```text
host quiz:create ─► PIN ─► players quiz:join ─► lobby:update
host quiz:start ─► quiz:starting (3 s)
  ┌─► question:start ─► question:tick every 1 s ─► answer:submit ...
  │   15 s over OR everyone answered
  │   ─► question:time_up ─► leaderboard:update ─► answer:result (per player)
  └── 5 s later, next question
after the last one ─► quiz:ended { winner, finalRanks }
```

Each game draws 5 random questions from the chosen category (`Mixed` = whole
bank).

## Socket events

### Lobby & control

| Event           | Direction        | Payload                                            |
| --------------- | ---------------- | -------------------------------------------------- |
| `quiz:create`   | host → server    | `{ hostName, category }`                           |
| `quiz:created`  | server → host    | `{ pin, roomId, category, totalQuestions }`        |
| `quiz:join`     | player → server  | `{ pin, playerName }`                              |
| `quiz:joined`   | server → player  | `{ pin, playerName, hostName, category }`          |
| `lobby:update`  | server → room    | `{ players: [{ name, score }] }`                   |
| `quiz:start`    | host → server    | `{ pin }` (only the host's socket is accepted)     |
| `quiz:starting` | server → room    | `{ countdown, totalQuestions }`                    |
| `quiz:error`    | server → client  | `{ message }`                                      |
| `quiz:closed`   | server → room    | `{ message }` when the host disconnects            |

### Rounds

| Event                | Direction        | Payload                                                                  |
| -------------------- | ---------------- | ------------------------------------------------------------------------ |
| `question:start`     | server → room    | `{ questionIndex, totalQuestions, question, options, timeLimitSeconds }` (no answer) |
| `question:tick`      | server → room    | `{ timeRemaining }` every second                                         |
| `answer:submit`      | player → server  | `{ pin, selectedOption, timeTakenMs }`                                   |
| `answer:locked`      | server → player  | `{ selectedOption, timeTakenMs }` (server-measured)                      |
| `answer:rejected`    | server → player  | `{ reason }`                                                             |
| `answer:progress`    | server → host    | `{ answered, total }`                                                    |
| `question:time_up`   | server → room    | `{ questionIndex, correctOption, explanation, answeredCount }`           |
| `leaderboard:update` | server → room    | `{ leaderboard: [{ rank, name, score, gained, correct, connected }] }`   |
| `answer:result`      | server → player  | `{ answered, correct, points, score, rank }`                             |
| `quiz:ended`         | server → room    | `{ winner: { name, score }, finalRanks }`                                |

## Scoring

```js
// 500 base + up to 500 speed bonus = max 1000 per question
function calculateScore(isCorrect, timeTakenMs, totalTimeLimitMs = 15000) {
  if (!isCorrect) return 0;
  const timeRemaining = Math.max(0, totalTimeLimitMs - timeTakenMs);
  const speedBonus = Math.round((timeRemaining / totalTimeLimitMs) * 500);
  return 500 + speedBonus;
}
```

`timeTakenMs` is measured on the server (`now - questionStartedAt`). The
client's own `timeTakenMs` is stored but never trusted, so a modified client
cannot claim a 0 ms answer.

## Anti-cheat rules

- The correct option is never sent until time is up.
- Answers after 15 s (+300 ms network slack) → `Time is up for this question`.
- A second answer to the same question → `You already answered this question`.
- Option index out of range, or a socket that is not in the game → rejected.
- Only the host socket can start the quiz; nobody can join after it starts.

## Leaderboard

Sorted by score, highest first. Players on the same score share a rank
(1, 2, 2, 4). Each row also shows the points gained that round. A player who
disconnects mid-game keeps their score but is shown struck through; if
everyone still connected has answered, the round is revealed early.

## Testing

1. Start the server, open `host.html` in tab 1, click **Create Quiz**, note
   the PIN.
2. Open `player.html` in tabs 2 and 3, join as Player 1 and Player 2.
3. Click **Start Game** on the host.
4. Answer right away on Player 1, wait ~10 s on Player 2 (same correct
   option): Player 1 gets more points from the speed bonus.
5. Let the timer hit 0 on a question: the pad locks and any late answer is
   rejected by the server.
