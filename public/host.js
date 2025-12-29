const socket = io();

const quizSelect = document.getElementById("quizSelect");
const createBtn = document.getElementById("createBtn");
const setupMsg = document.getElementById("setupMsg");

const lobbyCard = document.getElementById("lobbyCard");
const pinEl = document.getElementById("pin");
const countEl = document.getElementById("count");
const playersEl = document.getElementById("players");

const startGameBtn = document.getElementById("startGameBtn");
const startQBtn = document.getElementById("startQBtn");
const revealBtn = document.getElementById("revealBtn");

const questionússia
const questionCard = document.getElementById("questionCard");
const qTitle = document.getElementById("qTitle");
const qMeta = document.getElementById("qMeta");
const qText = document.getElementById("qText");
const choicesEl = document.getElementById("choices");
const timerEl = document.getElementById("timer");
const hostMsg = document.getElementById("hostMsg");

const leaderCard = document.getElementById("leaderCard");
const leaderList = document.getElementById("leaderList");

let currentPin = null;
let timerInterval = null;

function setTimer(sec) {
  clearInterval(timerInterval);
  let left = sec;
  timerEl.textContent = String(left);
  timerInterval = setInterval(() => {
    left -= 1;
    timerEl.textContent = String(Math.max(0, left));
    if (left <= 0) clearInterval(timerInterval);
  }, 1000);
}

async function loadQuizList() {
  const res = await fetch("/api/quizzes");
  const data = await res.json();
  quizSelect.innerHTML = "";
  data.quizzes.forEach((q) => {
    const opt = document.createElement("option");
    opt.value = q.id;
    opt.textContent = `${q.title} (${q.questionCount} Q)`;
    quizSelect.appendChild(opt);
  });
}

createBtn.onclick = () => {
  setupMsg.textContent = "Creating game...";
  socket.emit("host:createGame", { quizId: quizSelect.value });
};

socket.on("host:gameCreated", ({ pin, title, questionCount }) => {
  currentPin = pin;
  setupMsg.textContent = `Game created: ${title} (${questionCount} questions)`;
  pinEl.textContent = pin;
  lobbyCard.style.display = "block";
  revealBtn.style.display = "none";
  revealBtn.disabled = true;
});

socket.on("host:error", ({ message }) => {
  setupMsg.textContent = message;
});

socket.on("lobby:update", ({ players }) => {
  countEl.textContent = String(players.length);
  playersEl.innerHTML = "";
  players.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p.name;
    playersEl.appendChild(li);
  });
});

startGameBtn.onclick = () => {
  socket.emit("host:startGame", { pin: currentPin });
};

startQBtn.onclick = () => {
  leaderCard.style.display = "none";
  revealBtn.style.display = "none";
  revealBtn.disabled = true;
  socket.emit("host:startQuestion", { pin: currentPin });
};

revealBtn.onclick = () => {
  revealBtn.disabled = true;
  socket.emit("host:reveal", { pin: currentPin });
};

socket.on("host:question", ({ index, total, text, choices, timeLimitSec }) => {
  questionCard.style.display = "block";
  qTitle.textContent = `Question ${index}`;
  qMeta.textContent = `of ${total} • Time: ${timeLimitSec}s`;
  qText.textContent = text;

  choicesEl.innerHTML = "";
  choices.forEach((c) => {
    const li = document.createElement("li");
    li.textContent = c;
    choicesEl.appendChild(li);
  });

  hostMsg.textContent = "Players are answering…";
  setTimer(timeLimitSec);
});

socket.on("host:revealReady", () => {
  hostMsg.textContent = "Time is up. Click Reveal + Leaderboard.";
  revealBtn.style.display = "inline-block";
  revealBtn.disabled = false;
});

socket.on("leaderboard:update", ({ full }) => {
  leaderCard.style.display = "block";
  leaderList.innerHTML = "";
  full.slice(0, 10).forEach((p) => {
    const li = document.createElement("li");
    li.textContent = `${p.rank}. ${p.name} — ${p.score}`;
    leaderList.appendChild(li);
  });
});

socket.on("game:final", ({ podium }) => {
  leaderCard.style.display = "block";
  leaderList.innerHTML = "";
  podium.forEach((p, idx) => {
    const li = document.createElement("li");
    li.textContent = `${idx + 1}. ${p.name} — ${p.score}`;
    leaderList.appendChild(li);
  });
});

loadQuizList();