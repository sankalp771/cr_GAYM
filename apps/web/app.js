const TURN_SECONDS = 20;

const BOARD_PRESETS = {
  classic: { id: "classic", label: "Classic", size: 6 },
  large: { id: "large", label: "Large", size: 8 },
  hd: { id: "hd", label: "HD", size: 10 },
  xl: { id: "xl", label: "XL", size: 12 },
  xxl: { id: "xxl", label: "XXL", size: 14 }
};

const PLAYER_COLORS = [
  "#ff5b8a",
  "#42f5d7",
  "#ffd54a",
  "#60a9ff",
  "#b583ff",
  "#ff9248",
  "#79ff6b",
  "#ff74f1"
];

const appState = {
  phase: "setup",
  settings: {
    presetId: "classic",
    playerCount: 2
  },
  players: [],
  currentPlayerIndex: 0,
  turnStartedAt: 0,
  timerRemainingMs: TURN_SECONDS * 1000,
  timerId: null,
  board: [],
  winnerId: null,
  lastAutoMove: null,
  moveCount: 0,
  lastMoveSummary: ""
};

const setupForm = document.querySelector("#setup-form");
const presetSelect = document.querySelector("#preset-select");
const playersSelect = document.querySelector("#players-select");
const playerFields = document.querySelector("#player-fields");
const resetButton = document.querySelector("#reset-button");
const boardElement = document.querySelector("#board");
const playerRoster = document.querySelector("#player-roster");
const presetLabel = document.querySelector("#preset-label");
const playersLabel = document.querySelector("#players-label");
const turnLabel = document.querySelector("#turn-label");
const timerLabel = document.querySelector("#timer-label");
const statusText = document.querySelector("#status-text");
const timerBar = document.querySelector("#timer-bar");

function createEmptyBoard(size) {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => ({
      row,
      col,
      ownerId: null,
      count: 0,
      flashTick: 0
    }))
  );
}

function getNeighbors(board, row, col) {
  const neighbors = [];
  const size = board.length;

  if (row > 0) {
    neighbors.push([row - 1, col]);
  }
  if (row < size - 1) {
    neighbors.push([row + 1, col]);
  }
  if (col > 0) {
    neighbors.push([row, col - 1]);
  }
  if (col < size - 1) {
    neighbors.push([row, col + 1]);
  }

  return neighbors;
}

function getCriticalMass(board, row, col) {
  return getNeighbors(board, row, col).length;
}

function isCellPlayable(cell, playerId) {
  return cell.ownerId === null || cell.ownerId === playerId;
}

function cloneBoard(board) {
  return board.map((row) => row.map((cell) => ({ ...cell })));
}

function getValidMoves(board, playerId) {
  const moves = [];

  board.forEach((row) => {
    row.forEach((cell) => {
      if (isCellPlayable(cell, playerId)) {
        moves.push({ row: cell.row, col: cell.col });
      }
    });
  });

  return moves;
}

function applyMove(board, playerId, row, col) {
  const nextBoard = cloneBoard(board);
  const queue = [{ row, col }];
  const touchedCells = new Set([`${row}:${col}`]);

  nextBoard[row][col].ownerId = playerId;
  nextBoard[row][col].count += 1;

  while (queue.length > 0) {
    const current = queue.shift();
    const cell = nextBoard[current.row][current.col];
    const criticalMass = getCriticalMass(nextBoard, current.row, current.col);

    if (cell.count < criticalMass) {
      continue;
    }

    cell.count -= criticalMass;
    if (cell.count === 0) {
      cell.ownerId = null;
    }

    for (const [neighborRow, neighborCol] of getNeighbors(nextBoard, current.row, current.col)) {
      const neighborCell = nextBoard[neighborRow][neighborCol];
      neighborCell.ownerId = playerId;
      neighborCell.count += 1;
      touchedCells.add(`${neighborRow}:${neighborCol}`);

      if (neighborCell.count >= getCriticalMass(nextBoard, neighborRow, neighborCol)) {
        queue.push({ row: neighborRow, col: neighborCol });
      }
    }
  }

  const flashTick = Date.now();
  for (const key of touchedCells) {
    const [cellRow, cellCol] = key.split(":").map(Number);
    nextBoard[cellRow][cellCol].flashTick = flashTick;
  }

  return nextBoard;
}

function countPlayerCells(board, playerId) {
  let total = 0;
  board.forEach((row) => {
    row.forEach((cell) => {
      if (cell.ownerId === playerId) {
        total += cell.count;
      }
    });
  });
  return total;
}

function updateEliminations() {
  if (appState.moveCount < appState.players.length) {
    return;
  }

  appState.players.forEach((player) => {
    const ownedCells = countPlayerCells(appState.board, player.id);
    if (player.hasEnteredPlay && ownedCells === 0) {
      player.isEliminated = true;
    }
  });
}

function getActivePlayers() {
  return appState.players.filter((player) => !player.isEliminated);
}

function evaluateWinner() {
  const playersWhoEnteredPlay = appState.players.filter((player) => player.hasEnteredPlay);
  const activePlayers = getActivePlayers();

  if (appState.moveCount < appState.players.length || playersWhoEnteredPlay.length < appState.players.length) {
    return null;
  }

  if (activePlayers.length === 1) {
    return activePlayers[0].id;
  }

  return null;
}

function advanceTurn() {
  const totalPlayers = appState.players.length;
  for (let step = 1; step <= totalPlayers; step += 1) {
    const candidateIndex = (appState.currentPlayerIndex + step) % totalPlayers;
    const candidate = appState.players[candidateIndex];

    if (!candidate.isEliminated) {
      appState.currentPlayerIndex = candidateIndex;
      appState.turnStartedAt = Date.now();
      appState.timerRemainingMs = TURN_SECONDS * 1000;
      appState.lastAutoMove = null;
      return;
    }
  }
}

function clearTimer() {
  if (appState.timerId) {
    window.clearInterval(appState.timerId);
    appState.timerId = null;
  }
}

function handleAutoMove() {
  const currentPlayer = appState.players[appState.currentPlayerIndex];
  if (!currentPlayer || currentPlayer.isEliminated || appState.phase !== "playing") {
    return;
  }

  const moves = getValidMoves(appState.board, currentPlayer.id);
  if (moves.length === 0) {
    return;
  }

  const move = moves[Math.floor(Math.random() * moves.length)];
  appState.lastAutoMove = move;
  commitMove(move.row, move.col, true);
}

function startTimerLoop() {
  clearTimer();
  appState.turnStartedAt = Date.now();
  appState.timerRemainingMs = TURN_SECONDS * 1000;

  appState.timerId = window.setInterval(() => {
    const elapsed = Date.now() - appState.turnStartedAt;
    const remaining = Math.max(0, TURN_SECONDS * 1000 - elapsed);
    appState.timerRemainingMs = remaining;
    renderTimer();

    if (remaining === 0) {
      handleAutoMove();
    }
  }, 100);
}

function commitMove(row, col, isAutoMove = false) {
  if (appState.phase !== "playing") {
    return;
  }

  const currentPlayer = appState.players[appState.currentPlayerIndex];
  const cell = appState.board[row][col];

  if (!currentPlayer || currentPlayer.isEliminated || !isCellPlayable(cell, currentPlayer.id)) {
    return;
  }

  clearTimer();
  currentPlayer.hasEnteredPlay = true;
  appState.moveCount += 1;
  appState.board = applyMove(appState.board, currentPlayer.id, row, col);
  updateEliminations();
  appState.lastMoveSummary = isAutoMove
    ? `${currentPlayer.name}'s timer expired, so the prototype auto-played a valid move.`
    : `${currentPlayer.name} placed successfully.`;

  const winnerId = evaluateWinner();
  appState.winnerId = winnerId;

  if (winnerId) {
    appState.phase = "finished";
    render(isAutoMove);
    return;
  }

  advanceTurn();
  startTimerLoop();
  render(isAutoMove);
}

function buildPlayers(playerCount) {
  return Array.from({ length: playerCount }, (_, index) => ({
    id: `player-${index + 1}`,
    name: document.querySelector(`#player-name-${index + 1}`)?.value.trim() || `Player ${index + 1}`,
    color: PLAYER_COLORS[index],
    hasEnteredPlay: false,
    isEliminated: false
  }));
}

function formatPresetLabel(presetId) {
  const preset = BOARD_PRESETS[presetId];
  return `${preset.label} (${preset.size}x${preset.size})`;
}

function renderPlayerFields(playerCount) {
  playerFields.innerHTML = "";

  for (let index = 0; index < playerCount; index += 1) {
    const field = document.createElement("label");
    field.className = "field";
    field.innerHTML = `
      <span>Player ${index + 1} Name</span>
      <input
        id="player-name-${index + 1}"
        type="text"
        maxlength="20"
        value="Player ${index + 1}"
        autocomplete="off"
      />
    `;
    playerFields.appendChild(field);
  }
}

function renderRoster() {
  playerRoster.innerHTML = "";

  appState.players.forEach((player, index) => {
    const card = document.createElement("article");
    card.className = "player-card";
    card.style.setProperty("--player-color", player.color);

    if (appState.phase === "playing" && index === appState.currentPlayerIndex) {
      card.classList.add("current-turn");
    }

    const ownedCells = countPlayerCells(appState.board, player.id);
    let status = `${ownedCells} orbs`;
    let tagClass = "status-tag";

    if (player.isEliminated) {
      status = "Spectating";
      tagClass = "status-tag eliminated";
    } else if (appState.phase === "playing" && index === appState.currentPlayerIndex) {
      status = "Your turn";
    } else if (!player.hasEnteredPlay) {
      status = "Waiting to enter";
    }

    card.innerHTML = `
      <div class="player-main">
        <span class="player-swatch" aria-hidden="true"></span>
        <div class="player-meta">
          <strong>${player.name}</strong>
          <span class="player-subtext">${ownedCells} orbs on board</span>
        </div>
      </div>
      <span class="${tagClass}">${status}</span>
    `;

    playerRoster.appendChild(card);
  });

  playersLabel.textContent = `${getActivePlayers().length} active`;
}

function createOrbMarkup(count, color) {
  const orbs = [];
  for (let index = 0; index < count; index += 1) {
    const orbCountClass = `count-${Math.min(count, 4)}`;
    orbs.push(`<span class="orb ${orbCountClass}" style="--player-color: ${color};"></span>`);
  }

  return `<div class="orb-stack">${orbs.join("")}</div>`;
}

function renderBoard() {
  const size = appState.board.length || BOARD_PRESETS[appState.settings.presetId].size;
  boardElement.style.gridTemplateColumns = `repeat(${size}, minmax(0, 1fr))`;
  boardElement.innerHTML = "";

  const currentPlayer = appState.players[appState.currentPlayerIndex];

  appState.board.forEach((row) => {
    row.forEach((cell) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cell";
      button.dataset.row = String(cell.row);
      button.dataset.col = String(cell.col);

      const cellPlayer = appState.players.find((player) => player.id === cell.ownerId);
      const isPlayableNow = currentPlayer && isCellPlayable(cell, currentPlayer.id) && appState.phase === "playing";
      const isCritical = cell.count > 0 && cell.count === getCriticalMass(appState.board, cell.row, cell.col) - 1;

      if (cellPlayer) {
        button.style.setProperty("--player-color", cellPlayer.color);
      }
      if (isPlayableNow) {
        button.classList.add("playable");
      } else {
        button.classList.add("blocked");
      }
      if (isCritical && cellPlayer) {
        button.classList.add("critical");
      }
      if (Date.now() - cell.flashTick < 380) {
        button.classList.add("flash");
      }

      if (cell.count > 0 && cellPlayer) {
        button.innerHTML = createOrbMarkup(cell.count, cellPlayer.color);
      }

      button.addEventListener("click", () => {
        commitMove(cell.row, cell.col, false);
      });

      boardElement.appendChild(button);
    });
  });
}

function renderTimer() {
  const remainingSeconds = (appState.timerRemainingMs / 1000).toFixed(1);
  const width = `${(appState.timerRemainingMs / (TURN_SECONDS * 1000)) * 100}%`;
  timerLabel.textContent = `${remainingSeconds}s`;
  timerBar.style.width = width;
}

function render(isAutoMove = false) {
  presetLabel.textContent = formatPresetLabel(appState.settings.presetId);

  if (appState.phase === "setup") {
    turnLabel.textContent = "Not started";
    timerLabel.textContent = `${TURN_SECONDS}s`;
    timerBar.style.width = "100%";
    statusText.textContent = "Configure the match and start a local prototype round.";
  } else if (appState.phase === "playing") {
    const currentPlayer = appState.players[appState.currentPlayerIndex];
    turnLabel.textContent = currentPlayer ? currentPlayer.name : "Waiting";

    if (isAutoMove && appState.lastMoveSummary) {
      statusText.textContent = `${appState.lastMoveSummary} ${currentPlayer.name} is up next.`;
    } else if (appState.lastMoveSummary && appState.moveCount > 0) {
      statusText.textContent = `${appState.lastMoveSummary} ${currentPlayer.name} is up next.`;
    } else {
      statusText.textContent = `${currentPlayer.name} is up. Place into an empty cell or one you already own.`;
    }

    renderTimer();
  } else if (appState.phase === "finished") {
    const winner = appState.players.find((player) => player.id === appState.winnerId);
    turnLabel.textContent = winner ? winner.name : "Finished";
    timerLabel.textContent = "0.0s";
    timerBar.style.width = "0%";
    statusText.textContent = winner
      ? `${winner.name} wins the local prototype match.`
      : "Match finished.";
  }

  renderRoster();
  renderBoard();
}

function startMatch() {
  const presetId = presetSelect.value;
  const playerCount = Number(playersSelect.value);
  const preset = BOARD_PRESETS[presetId];

  appState.settings = { presetId, playerCount };
  appState.players = buildPlayers(playerCount);
  appState.board = createEmptyBoard(preset.size);
  appState.currentPlayerIndex = 0;
  appState.phase = "playing";
  appState.winnerId = null;
  appState.lastAutoMove = null;
  appState.moveCount = 0;
  appState.lastMoveSummary = "";
  startTimerLoop();
  render();
}

function resetPrototype() {
  clearTimer();
  appState.phase = "setup";
  appState.players = [];
  appState.board = createEmptyBoard(BOARD_PRESETS[presetSelect.value].size);
  appState.currentPlayerIndex = 0;
  appState.winnerId = null;
  appState.lastAutoMove = null;
  appState.moveCount = 0;
  appState.lastMoveSummary = "";
  render();
}

playersSelect.addEventListener("change", (event) => {
  renderPlayerFields(Number(event.target.value));
});

presetSelect.addEventListener("change", () => {
  if (appState.phase === "setup") {
    appState.board = createEmptyBoard(BOARD_PRESETS[presetSelect.value].size);
    render();
  }
});

setupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  startMatch();
});

resetButton.addEventListener("click", () => {
  renderPlayerFields(Number(playersSelect.value));
  resetPrototype();
});

renderPlayerFields(appState.settings.playerCount);
appState.board = createEmptyBoard(BOARD_PRESETS[appState.settings.presetId].size);
render();
