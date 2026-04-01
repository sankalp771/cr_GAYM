const BOARD_PRESETS = {
  classic: { id: "classic", label: "Classic", size: 6 },
  large: { id: "large", label: "Large", size: 8 },
  hd: { id: "hd", label: "HD", size: 10 },
  xl: { id: "xl", label: "XL", size: 12 },
  xxl: { id: "xxl", label: "XXL", size: 14 }
};

const state = {
  sessionId: localStorage.getItem("crg_session_id") || null,
  room: null,
  connectionOpen: false,
  clockOffsetMs: 0,
  timerId: null,
  lastRenderedBoardKey: ""
};

const setupForm = document.querySelector("#setup-form");
const displayNameInput = document.querySelector("#display-name-input");
const roomCodeInput = document.querySelector("#room-code-input");
const presetSelect = document.querySelector("#preset-select");
const playersSelect = document.querySelector("#players-select");
const leaveRoomButton = document.querySelector("#leave-room-button");
const readyButton = document.querySelector("#ready-button");
const startMatchButton = document.querySelector("#start-match-button");
const boardElement = document.querySelector("#board");
const playerRoster = document.querySelector("#player-roster");
const presetLabel = document.querySelector("#preset-label");
const playersLabel = document.querySelector("#players-label");
const roomLabel = document.querySelector("#room-label");
const phaseLabel = document.querySelector("#phase-label");
const turnLabel = document.querySelector("#turn-label");
const timerLabel = document.querySelector("#timer-label");
const statusText = document.querySelector("#status-text");
const timerBar = document.querySelector("#timer-bar");
const winnerModal = document.querySelector("#winner-modal");
const winnerTitle = document.querySelector("#winner-title");
const winnerMessage = document.querySelector("#winner-message");
const playAgainButton = document.querySelector("#play-again-button");
const closeModalButton = document.querySelector("#close-modal-button");

let pendingFormAction = "create";
let socket;

function createEmptyBoard(size) {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => ({
      row,
      col,
      ownerSessionId: null,
      count: 0,
      flashTick: 0
    }))
  );
}

function getCriticalMass(board, row, col) {
  let count = 0;
  if (row > 0) count += 1;
  if (row < board.length - 1) count += 1;
  if (col > 0) count += 1;
  if (col < board.length - 1) count += 1;
  return count;
}

function getCurrentUserMember() {
  return state.room?.members.find((member) => member.sessionId === state.sessionId) || null;
}

function canCurrentUserReady() {
  const me = getCurrentUserMember();
  return Boolean(state.room && state.room.status === "lobby" && me && !me.isHost);
}

function canCurrentUserStart() {
  const me = getCurrentUserMember();
  return Boolean(state.room && state.room.status === "lobby" && me?.isHost && state.room.canStart);
}

function getBoardToRender() {
  if (state.room?.match?.board) {
    return state.room.match.board;
  }

  const preset = BOARD_PRESETS[state.room?.settings?.presetId || presetSelect.value];
  return createEmptyBoard(preset.size);
}

function formatPresetLabel(presetId) {
  const preset = BOARD_PRESETS[presetId];
  return `${preset.label} (${preset.size}x${preset.size})`;
}

function openWinnerModal(winnerName) {
  winnerTitle.textContent = `${winnerName} Wins`;
  winnerMessage.textContent = `${winnerName} wins the room match. You can close this result card and create or join another room.`;
  winnerModal.classList.remove("hidden");
  winnerModal.setAttribute("aria-hidden", "false");
}

function closeWinnerModal() {
  winnerModal.classList.add("hidden");
  winnerModal.setAttribute("aria-hidden", "true");
}

function sendMessage(type, payload = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify({ type, payload }));
}

function updateActionButtons() {
  const inRoom = Boolean(state.room);
  const currentUser = getCurrentUserMember();

  leaveRoomButton.disabled = !inRoom;
  readyButton.hidden = !canCurrentUserReady();
  readyButton.disabled = !canCurrentUserReady();
  readyButton.textContent = currentUser?.ready ? "Unready" : "Ready Up";

  startMatchButton.hidden = !Boolean(state.room && currentUser?.isHost);
  startMatchButton.disabled = !canCurrentUserStart();

  displayNameInput.disabled = inRoom;
  roomCodeInput.disabled = inRoom;
  presetSelect.disabled = inRoom;
  playersSelect.disabled = inRoom;
}

function renderRoster() {
  playerRoster.innerHTML = "";

  const members = state.room?.members || [];
  const capacity = state.room?.settings?.maxPlayers || 0;
  playersLabel.textContent = state.room ? `${members.length}/${capacity} players` : "0 active";

  members.forEach((member) => {
    const card = document.createElement("article");
    card.className = "player-card";
    card.style.setProperty("--player-color", member.color || "#8ef9ff");

    if (state.room?.match?.currentPlayerSessionId === member.sessionId && state.room.status === "active") {
      card.classList.add("current-turn");
    }

    let status = member.isHost ? "Host" : "Joined";
    let tagClass = "status-tag";

    if (state.room?.status === "lobby" && !member.isHost) {
      status = member.ready ? "Ready" : "Waiting";
    }
    if (state.room?.status === "active" && member.isEliminated) {
      status = "Spectating";
      tagClass = "status-tag eliminated";
    } else if (state.room?.status === "active" && state.room.match.currentPlayerSessionId === member.sessionId) {
      status = "Your turn";
    }
    if (!member.isConnected) {
      status = "Disconnected";
      tagClass = "status-tag eliminated";
    }

    const orbCount = member.orbCount ?? 0;
    card.innerHTML = `
      <div class="player-main">
        <span class="player-swatch" aria-hidden="true"></span>
        <div class="player-meta">
          <strong>${member.name}</strong>
          <span class="player-subtext">${orbCount} orbs on board</span>
        </div>
      </div>
      <span class="${tagClass}">${status}</span>
    `;

    playerRoster.appendChild(card);
  });
}

function createOrbMarkup(count, color) {
  const orbs = [];
  for (let index = 0; index < count; index += 1) {
    const orbCountClass = `count-${Math.min(count, 4)}`;
    orbs.push(`<span class="orb ${orbCountClass}" style="--player-color: ${color};"></span>`);
  }
  return `<div class="orb-stack">${orbs.join("")}</div>`;
}

function getBoardKey(board) {
  return board
    .flat()
    .map((cell) => `${cell.ownerSessionId || "x"}:${cell.count}:${cell.flashTick || 0}`)
    .join("|");
}

function renderBoard() {
  const board = getBoardToRender();
  const previousBoardKey = state.lastRenderedBoardKey;
  const currentBoardKey = getBoardKey(board);
  boardElement.style.gridTemplateColumns = `repeat(${board.length}, minmax(0, 1fr))`;
  boardElement.innerHTML = "";

  const me = getCurrentUserMember();
  const currentTurnSessionId = state.room?.match?.currentPlayerSessionId;
  const canPlay = state.room?.status === "active" && me && !me.isEliminated && currentTurnSessionId === state.sessionId;

  board.forEach((row) => {
    row.forEach((cell) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cell";

      const owner = state.room?.members.find((member) => member.sessionId === cell.ownerSessionId);
      const isPlayable = canPlay && (cell.ownerSessionId === null || cell.ownerSessionId === state.sessionId);
      const isCritical = cell.count > 0 && cell.count === getCriticalMass(board, cell.row, cell.col) - 1;

      if (owner?.color) {
        button.style.setProperty("--player-color", owner.color);
      }
      button.classList.add(isPlayable ? "playable" : "blocked");
      if (isCritical && owner?.color) {
        button.classList.add("critical");
      }
      if (Date.now() - (cell.flashTick || 0) < 380) {
        button.classList.add("flash");
      }
      if (cell.ownerSessionId && previousBoardKey && currentBoardKey !== previousBoardKey) {
        button.classList.add("energized");
      }
      if (cell.count > 0 && owner?.color) {
        button.innerHTML = createOrbMarkup(cell.count, owner.color);
      }

      button.addEventListener("click", () => {
        if (!state.room) {
          return;
        }
        sendMessage("match.move", {
          roomCode: state.room.code,
          row: cell.row,
          col: cell.col
        });
      });

      boardElement.appendChild(button);
    });
  });

  state.lastRenderedBoardKey = currentBoardKey;
}

function renderTimer() {
  const match = state.room?.match;
  if (!match || !match.turnDeadlineAt || state.room.status !== "active") {
    timerLabel.textContent = "20.0s";
    timerBar.style.width = "100%";
    return;
  }

  const remainingMs = Math.max(0, match.turnDeadlineAt - (Date.now() + state.clockOffsetMs));
  timerLabel.textContent = `${(remainingMs / 1000).toFixed(1)}s`;
  timerBar.style.width = `${(remainingMs / (state.room.settings.turnTimeSeconds * 1000)) * 100}%`;
}

function renderStatus() {
  if (!state.room) {
    statusText.textContent = state.connectionOpen
      ? "Create a room or join one with a code to enter the lobby."
      : "Connecting to the realtime server...";
    return;
  }

  if (state.room.status === "lobby") {
    statusText.textContent = state.room.canStart
      ? "Everyone is in. Host can start the room now."
      : "Waiting for the room to fill and for every non-host player to ready up.";
    return;
  }

  if (state.room.status === "active") {
    statusText.textContent = state.room.match.lastMoveSummary || "The room match is live.";
    return;
  }

  statusText.textContent = state.room.match?.winnerName
    ? `${state.room.match.winnerName} won the room match.`
    : "Match finished.";
}

function render() {
  document.body.classList.toggle("match-active", Boolean(state.room));
  document.body.style.setProperty(
    "--turn-color",
    state.room?.members.find((member) => member.sessionId === state.room?.match?.currentPlayerSessionId)?.color || "#8ef9ff"
  );
  updateActionButtons();

  const presetId = state.room?.settings?.presetId || presetSelect.value;
  presetLabel.textContent = formatPresetLabel(presetId);
  roomLabel.textContent = state.room ? state.room.code : "No room";
  phaseLabel.textContent = state.room ? state.room.status.toUpperCase() : "IDLE";
  turnLabel.textContent = state.room?.match?.currentPlayerName || "Not started";

  renderTimer();
  renderStatus();
  renderRoster();
  renderBoard();
}

function startRenderLoop() {
  if (state.timerId) {
    window.clearInterval(state.timerId);
  }
  state.timerId = window.setInterval(renderTimer, 100);
}

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}`);

  socket.addEventListener("open", () => {
    state.connectionOpen = true;
    sendMessage("session.restore", {
      sessionId: state.sessionId,
      roomCode: new URLSearchParams(window.location.search).get("room")
    });
    render();
  });

  socket.addEventListener("close", () => {
    state.connectionOpen = false;
    render();
    window.setTimeout(connect, 1200);
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "session.ready") {
      state.sessionId = message.payload.sessionId;
      localStorage.setItem("crg_session_id", state.sessionId);
    }

    if (message.type === "room.snapshot" || message.type === "match.started") {
      state.room = message.payload.room;
      state.clockOffsetMs = message.payload.serverNow - Date.now();
      const roomUrl = state.room ? `${window.location.pathname}?room=${state.room.code}` : window.location.pathname;
      window.history.replaceState({}, "", roomUrl);
      closeWinnerModal();
      render();
    }

    if (message.type === "match.finished") {
      state.room = message.payload.room;
      state.clockOffsetMs = message.payload.serverNow - Date.now();
      render();
      if (message.payload.winnerName) {
        openWinnerModal(message.payload.winnerName);
      }
    }

    if (message.type === "room.error") {
      window.alert(message.payload.message);
    }
  });
}

setupForm.addEventListener("click", (event) => {
  const action = event.target.dataset.action;
  if (action) {
    pendingFormAction = action;
  }
});

setupForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const payload = {
    displayName: displayNameInput.value.trim() || "Player",
    presetId: presetSelect.value,
    maxPlayers: Number(playersSelect.value),
    roomCode: roomCodeInput.value.trim().toUpperCase()
  };

  if (pendingFormAction === "create") {
    sendMessage("room.create", payload);
    return;
  }

  sendMessage("room.join", payload);
});

leaveRoomButton.addEventListener("click", () => {
  if (state.room) {
    sendMessage("room.leave", { roomCode: state.room.code });
  }
});

readyButton.addEventListener("click", () => {
  if (state.room) {
    sendMessage("room.ready", { roomCode: state.room.code });
  }
});

startMatchButton.addEventListener("click", () => {
  if (state.room) {
    sendMessage("room.start", { roomCode: state.room.code });
  }
});

playAgainButton.addEventListener("click", closeWinnerModal);
closeModalButton.addEventListener("click", closeWinnerModal);
winnerModal.addEventListener("click", (event) => {
  if (event.target === winnerModal || event.target.classList.contains("modal-backdrop")) {
    closeWinnerModal();
  }
});

startRenderLoop();
connect();
render();
