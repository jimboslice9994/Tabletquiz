"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false } // same-origin only
});

const PORT = process.env.PORT || 5000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me-now";
const QUIZ_FILE = path.join(__dirname, "quizzes.json");

// ---------- Security middleware ----------
app.use(helmet({
  contentSecurityPolicy: false // keep simple for MVP static files
}));
app.use(express.json({ limit: "200kb" })); // prevent huge payload spam
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120, // per IP per minute
}));

// Serve static files
app.use(express.static(path.join(__dirname, "public"), {
  etag: false
}));

function sanitizeText(s, maxLen = 60) {
  return String(s ?? "")
    .replace(/[<>"]/g, "")
    .trim()
    .slice(0, maxLen);
}

function loadQuizzes() {
  try {
    const raw = fs.readFileSync(QUIZ_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.quizzes)) return { quizzes: [] };
    return data;
  } catch {
    return { quizzes: [] };
  }
}

function saveQuizzes(data) {
  fs.writeFileSync(QUIZ_FILE, JSON.stringify(data, null, 2), "utf8");
}

function makePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function computePoints({ correct, elapsedMs, timeLimitSec }) {
  if (!correct) return 0;
  const T = timeLimitSec * 1000;
  const t = Math.max(0, Math.min(elapsedMs, T));
  const frac = 1 - t / T; // 1 fast -> 0 slow
  return Math.round(200 + 1000 * frac);
}

function leaderboard(game) {
  const sorted = [...game.players.values()].sort((a, b) => b.score - a.score);
  return sorted.map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
}

// ---------- Pages ----------
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/host", (_, res) => res.sendFile(path.join(__dirname, "public", "host.html")));

// ---------- API ----------
app.get("/api/quizzes", (_, res) => {
  const data = loadQuizzes();
  res.json({
    quizzes: data.quizzes.map(q => ({
      id: q.id,
      title: q.title,
      questionCount: q.questions.length
    }))
  });
});

// ---------- Game state (in-memory) ----------
const games = new Map(); // pin -> game

io.on("connection", (socket) => {

  socket.on("host:createGame", ({ quizId }) => {
    const data = loadQuizzes();
    const quiz = data.quizzes.find(q => q.id === quizId);
    if (!quiz) return socket.emit("host:error", { message: "Quiz not found" });

    const pin = makePin();
    const game = {
      pin,
      hostId: socket.id,
      quiz,
      phase: "lobby",
      currentIndex: -1,
      questionStart: 0,
      answered: new Set(),
      revealTimer: null,
      players: new Map() // socketId -> {name, score, streak}
    };

    games.set(pin, game);
    socket.join(pin);

    socket.emit("host:gameCreated", { pin, title: quiz.title, questionCount: quiz.questions.length });
    io.to(pin).emit("lobby:update", { players: [] });
  });

  socket.on("host:startGame", ({ pin }) => {
    const game = games.get(String(pin));
    if (!game || game.hostId !== socket.id) return;
    game.phase = "inGame";
    io.to(pin).emit("game:started", { title: game.quiz.title });
  });

  socket.on("host:startQuestion", ({ pin }) => {
    const game = games.get(String(pin));
    if (!game || game.hostId !== socket.id) return;

    // Move to next question
    game.currentIndex += 1;

    if (game.currentIndex >= game.quiz.questions.length) {
      const board = leaderboard(game);
      io.to(pin).emit("game:final", { podium: board.slice(0, 3), leaderboard: board });
      games.delete(pin);
      return;
    }

    const q = game.quiz.questions[game.currentIndex];
    game.phase = "question";
    game.questionStart = Date.now();
    game.answered = new Set();

    // Host sees full question + choices
    socket.emit("host:question", {
      index: game.currentIndex + 1,
      total: game.quiz.questions.length,
      text: q.text,
      choices: q.choices,
      timeLimitSec: q.timeLimitSec
    });

    // Players see answer buttons
    io.to(pin).emit("player:question", {
      index: game.currentIndex + 1,
      total: game.quiz.questions.length,
      choices: q.choices,
      timeLimitSec: q.timeLimitSec
    });

    // Per-game timer
    clearTimeout(game.revealTimer);
    game.revealTimer = setTimeout(() => {
      const g = games.get(String(pin));
      if (!g || g.hostId !== socket.id) return;
      if (g.phase !== "question") return;
      io.to(pin).emit("question:timeUp", {});
      socket.emit("host:revealReady", { pin });
    }, q.timeLimitSec * 1000);
  });

  socket.on("host:reveal", ({ pin }) => {
    const game = games.get(String(pin));
    if (!game || game.hostId !== socket.id) return;
    if (game.phase !== "question") return;

    clearTimeout(game.revealTimer);
    game.phase = "reveal";

    const q = game.quiz.questions[game.currentIndex];
    io.to(pin).emit("question:reveal", { correctIndex: q.correctIndex });

    const board = leaderboard(game);
    io.to(pin).emit("leaderboard:update", { full: board, top: board.slice(0, 5) });
  });

  socket.on("player:join", ({ pin, name }) => {
    const code = String(pin || "").trim();
    const game = games.get(code);
    if (!game) return socket.emit("player:error", { message: "Game not found. Check PIN." });

    const cleanName = sanitizeText(name, 16);
    if (!cleanName) return socket.emit("player:error", { message: "Enter a name." });

    for (const p of game.players.values()) {
      if (p.name.toLowerCase() === cleanName.toLowerCase()) {
        return socket.emit("player:error", { message: "Name taken. Try another." });
      }
    }

    game.players.set(socket.id, { name: cleanName, score: 0, streak: 0 });
    socket.join(code);

    const list = [...game.players.values()].map(p => ({ name: p.name }));
    io.to(code).emit("lobby:update", { players: list });

    socket.emit("player:joined", { pin: code, name: cleanName, title: game.quiz.title });
  });

  socket.on("player:answer", ({ pin, choiceIndex }) => {
    const code = String(pin || "").trim();
    const game = games.get(code);
    if (!game || game.phase !== "question") return;

    if (game.answered.has(socket.id)) return;
    game.answered.add(socket.id);

    const player = game.players.get(socket.id);
    if (!player) return;

    const q = game.quiz.questions[game.currentIndex];
    const elapsed = Date.now() - game.questionStart;
    const correct = Number(choiceIndex) === Number(q.correctIndex);

    const pts = computePoints({ correct, elapsedMs: elapsed, timeLimitSec: q.timeLimitSec });

    if (correct) {
      player.streak += 1;
      const streakBonus = player.streak >= 2 ? 50 * (player.streak - 1) : 0;
      player.score += pts + streakBonus;
    } else {
      player.streak = 0;
    }

    socket.emit("player:answerResult", {
      correct,
      gained: correct ? pts : 0,
      total: player.score
    });
  });

  socket.on("disconnect", () => {
    for (const [pin, game] of games.entries()) {
      if (game.hostId === socket.id) {
        io.to(pin).emit("game:ended", { message: "Host disconnected." });
        games.delete(pin);
        continue;
      }
      if (game.players.has(socket.id)) {
        game.players.delete(socket.id);
        const list = [...game.players.values()].map(p => ({ name: p.name }));
        io.to(pin).emit("lobby:update", { players: list });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Quiz MVP running on port ${PORT}`);
});