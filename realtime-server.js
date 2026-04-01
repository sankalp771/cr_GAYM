const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const TURN_TIME_SECONDS = 20;
const WEB_ROOT = path.join(__dirname, "apps", "web");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8"
};

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

const sockets = new Map();
const sessions = new Map();
const rooms = new Map();

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

function getNeighbors(board, row, col) {
  const neighbors = [];
  if (row > 0) neighbors.push([row - 1, col]);
  if (row < board.length - 1) neighbors.push([row + 1, col]);
  if (col > 0) neighbors.push([row, col - 1]);
  if (col < board.length - 1) neighbors.push([row, col + 1]);
  return neighbors;
}

function getCriticalMass(board, row, col) {
  return getNeighbors(board, row, col).length;
}

function cloneBoard(board) {
  return board.map((row) => row.map((cell) => ({ ...cell })));
}

function applyMove(board, playerId, row, col) {
  const nextBoard = cloneBoard(board);
  const touchedCells = new Set([`${row}:${col}`]);

  nextBoard[row][col].ownerSessionId = playerId;
  nextBoard[row][col].count += 1;

  while (true) {
    const unstableCells = [];

    nextBoard.forEach((boardRow) => {
      boardRow.forEach((cell) => {
        if (cell.count >= getCriticalMass(nextBoard, cell.row, cell.col)) {
          unstableCells.push({ row: cell.row, col: cell.col });
        }
      });
    });

    if (unstableCells.length === 0) {
      break;
    }

    unstableCells.forEach((unstableCell) => {
      const cell = nextBoard[unstableCell.row][unstableCell.col];
      const criticalMass = getCriticalMass(nextBoard, unstableCell.row, unstableCell.col);

      cell.count -= criticalMass;
      cell.ownerSessionId = cell.count === 0 ? null : playerId;

      for (const [neighborRow, neighborCol] of getNeighbors(nextBoard, unstableCell.row, unstableCell.col)) {
        const neighbor = nextBoard[neighborRow][neighborCol];
        neighbor.ownerSessionId = playerId;
        neighbor.count += 1;
        touchedCells.add(`${neighborRow}:${neighborCol}`);
      }
    });
  }

  const flashTick = Date.now();
  touchedCells.forEach((key) => {
    const [cellRow, cellCol] = key.split(":").map(Number);
    nextBoard[cellRow][cellCol].flashTick = flashTick;
  });

  return nextBoard;
}

function countPlayerOrbs(board, playerId) {
  let total = 0;
  board.forEach((row) => {
    row.forEach((cell) => {
      if (cell.ownerSessionId === playerId) {
        total += cell.count;
      }
    });
  });
  return total;
}

function generateCode(length = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  while (code.length < length) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function getSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  const nextSession = {
    sessionId: crypto.randomUUID(),
    roomCode: null
  };
  sessions.set(nextSession.sessionId, nextSession);
  return nextSession;
}

function getSocketContext(socket) {
  return sockets.get(socket) || null;
}

function send(socket, message) {
  if (!socket.destroyed) {
    socket.write(encodeFrame(JSON.stringify(message)));
  }
}

function sendError(socket, message) {
  send(socket, { type: "room.error", payload: { message } });
}

function buildRoomSnapshot(room) {
  const members = room.members.map((member, index) => ({
    sessionId: member.sessionId,
    name: member.name,
    ready: member.ready,
    isHost: member.sessionId === room.hostSessionId,
    isConnected: member.isConnected,
    isEliminated: member.isEliminated,
    color: member.color || PLAYER_COLORS[index],
    orbCount: room.match ? countPlayerOrbs(room.match.board, member.sessionId) : 0
  }));

  return {
    code: room.code,
    status: room.status,
    hostSessionId: room.hostSessionId,
    settings: room.settings,
    canStart: canStartRoom(room),
    members,
    match: room.match
      ? {
          board: room.match.board,
          currentPlayerSessionId: room.match.currentPlayerSessionId,
          currentPlayerName: room.members.find((member) => member.sessionId === room.match.currentPlayerSessionId)?.name || "",
          turnDeadlineAt: room.match.turnDeadlineAt,
          lastMoveSummary: room.match.lastMoveSummary,
          winnerName: room.match.winnerSessionId
            ? room.members.find((member) => member.sessionId === room.match.winnerSessionId)?.name || ""
            : ""
        }
      : null
  };
}

function broadcastRoom(room, type = "room.snapshot", extraPayload = {}) {
  const payload = {
    room: buildRoomSnapshot(room),
    serverNow: Date.now(),
    ...extraPayload
  };

  room.members.forEach((member) => {
    if (member.socket) {
      send(member.socket, { type, payload });
    }
  });
}

function leaveLobbyMember(room, sessionId) {
  room.members = room.members.filter((member) => member.sessionId !== sessionId);
  if (room.hostSessionId === sessionId && room.members.length > 0) {
    room.hostSessionId = room.members[0].sessionId;
  }
  if (room.members.length === 0) {
    rooms.delete(room.code);
  }
}

function detachFromRoom(sessionId, explicitLeave = false) {
  const session = sessions.get(sessionId);
  if (!session?.roomCode || !rooms.has(session.roomCode)) {
    if (session) {
      session.roomCode = null;
    }
    return;
  }

  const room = rooms.get(session.roomCode);
  const member = room.members.find((entry) => entry.sessionId === sessionId);
  if (!member) {
    session.roomCode = null;
    return;
  }

  if (room.status === "lobby" || explicitLeave) {
    leaveLobbyMember(room, sessionId);
  } else {
    member.isConnected = false;
    member.socket = null;
  }

  session.roomCode = null;
  if (rooms.has(room.code)) {
    broadcastRoom(room);
  }
}

function assignSocketToMember(socket, session, room, member) {
  member.socket = socket;
  member.isConnected = true;
  session.roomCode = room.code;
  sockets.set(socket, { sessionId: session.sessionId });
  broadcastRoom(room);
}

function createRoom(socket, session, payload) {
  detachFromRoom(session.sessionId, true);

  let code = generateCode();
  while (rooms.has(code)) {
    code = generateCode();
  }

  const room = {
    code,
    hostSessionId: session.sessionId,
    status: "lobby",
    settings: {
      presetId: BOARD_PRESETS[payload.presetId] ? payload.presetId : "classic",
      maxPlayers: Math.max(2, Math.min(8, Number(payload.maxPlayers) || 2)),
      turnTimeSeconds: TURN_TIME_SECONDS
    },
    members: [
      {
        sessionId: session.sessionId,
        name: (payload.displayName || "Host").trim().slice(0, 20),
        ready: true,
        isConnected: true,
        isEliminated: false,
        hasEnteredPlay: false,
        color: PLAYER_COLORS[0],
        socket
      }
    ],
    match: null,
    timerHandle: null
  };

  rooms.set(code, room);
  session.roomCode = code;
  sockets.set(socket, { sessionId: session.sessionId });
  broadcastRoom(room);
}

function joinRoom(socket, session, payload) {
  const code = (payload.roomCode || "").trim().toUpperCase();
  if (!rooms.has(code)) {
    sendError(socket, "Room not found.");
    return;
  }

  const room = rooms.get(code);
  const existingMember = room.members.find((member) => member.sessionId === session.sessionId);
  if (existingMember) {
    assignSocketToMember(socket, session, room, existingMember);
    return;
  }

  if (room.status !== "lobby") {
    sendError(socket, "The match has already started.");
    return;
  }

  if (room.members.length >= room.settings.maxPlayers) {
    sendError(socket, "The room is already full.");
    return;
  }

  detachFromRoom(session.sessionId, true);

  room.members.push({
    sessionId: session.sessionId,
    name: (payload.displayName || "Player").trim().slice(0, 20),
    ready: false,
    isConnected: true,
    isEliminated: false,
    hasEnteredPlay: false,
    color: PLAYER_COLORS[room.members.length],
    socket
  });

  session.roomCode = room.code;
  sockets.set(socket, { sessionId: session.sessionId });
  broadcastRoom(room);
}

function canStartRoom(room) {
  if (room.status !== "lobby") {
    return false;
  }
  if (room.members.length !== room.settings.maxPlayers) {
    return false;
  }
  return room.members.every((member) => member.sessionId === room.hostSessionId || member.ready);
}

function getValidMoves(room, sessionId) {
  const moves = [];
  room.match.board.forEach((row) => {
    row.forEach((cell) => {
      if (cell.ownerSessionId === null || cell.ownerSessionId === sessionId) {
        moves.push({ row: cell.row, col: cell.col });
      }
    });
  });
  return moves;
}

function updateEliminations(room) {
  if (room.match.moveCount < room.members.length) {
    return;
  }

  room.members.forEach((member) => {
    const owned = countPlayerOrbs(room.match.board, member.sessionId);
    if (member.hasEnteredPlay && owned === 0) {
      member.isEliminated = true;
    }
  });
}

function evaluateWinner(room) {
  if (room.match.moveCount < room.members.length) {
    return null;
  }
  const activeMembers = room.members.filter((member) => !member.isEliminated);
  return activeMembers.length === 1 ? activeMembers[0].sessionId : null;
}

function pickNextPlayer(room) {
  const aliveMembers = room.members.filter((member) => !member.isEliminated);
  if (aliveMembers.length === 0) {
    return null;
  }

  const currentIndex = room.members.findIndex((member) => member.sessionId === room.match.currentPlayerSessionId);
  for (let step = 1; step <= room.members.length; step += 1) {
    const candidate = room.members[(currentIndex + step) % room.members.length];
    if (!candidate.isEliminated) {
      return candidate.sessionId;
    }
  }
  return aliveMembers[0].sessionId;
}

function clearTurnTimer(room) {
  if (room.timerHandle) {
    clearTimeout(room.timerHandle);
    room.timerHandle = null;
  }
}

function scheduleTurnTimer(room) {
  clearTurnTimer(room);
  room.match.turnDeadlineAt = Date.now() + TURN_TIME_SECONDS * 1000;
  room.timerHandle = setTimeout(() => {
    const currentPlayerId = room.match.currentPlayerSessionId;
    const moves = getValidMoves(room, currentPlayerId);
    if (moves.length === 0) {
      return;
    }
    const move = moves[Math.floor(Math.random() * moves.length)];
    applyAuthoritativeMove(room, currentPlayerId, move.row, move.col, true);
  }, TURN_TIME_SECONDS * 1000);
}

function applyAuthoritativeMove(room, playerId, row, col, isAutoMove) {
  if (room.status !== "active" || room.match.currentPlayerSessionId !== playerId) {
    return;
  }

  const cell = room.match.board[row]?.[col];
  if (!cell || (cell.ownerSessionId !== null && cell.ownerSessionId !== playerId)) {
    return;
  }

  clearTurnTimer(room);

  const player = room.members.find((member) => member.sessionId === playerId);
  player.hasEnteredPlay = true;
  room.match.moveCount += 1;
  room.match.board = applyMove(room.match.board, playerId, row, col);
  room.match.lastMoveSummary = isAutoMove
    ? `${player.name}'s timer expired, so the server auto-played a valid move.`
    : `${player.name} made a move.`;

  updateEliminations(room);
  const winnerSessionId = evaluateWinner(room);

  if (winnerSessionId) {
    room.status = "finished";
    room.match.winnerSessionId = winnerSessionId;
    broadcastRoom(room, "match.finished", {
      winnerName: room.members.find((member) => member.sessionId === winnerSessionId)?.name || ""
    });
    return;
  }

  room.match.currentPlayerSessionId = pickNextPlayer(room);
  scheduleTurnTimer(room);
  broadcastRoom(room);
}

function startMatch(room) {
  const preset = BOARD_PRESETS[room.settings.presetId];
  room.status = "active";
  room.members.forEach((member, index) => {
    member.ready = true;
    member.isEliminated = false;
    member.hasEnteredPlay = false;
    member.color = PLAYER_COLORS[index];
  });
  room.match = {
    board: createEmptyBoard(preset.size),
    currentPlayerSessionId: room.members[0].sessionId,
    moveCount: 0,
    turnDeadlineAt: Date.now() + TURN_TIME_SECONDS * 1000,
    lastMoveSummary: `${room.members[0].name} starts the match.`,
    winnerSessionId: null
  };
  scheduleTurnTimer(room);
  broadcastRoom(room, "match.started");
}

function handleMessage(socket, rawText) {
  let message;
  try {
    message = JSON.parse(rawText);
  } catch {
    return;
  }

  const context = getSocketContext(socket);
  const session = getSession(message.payload?.sessionId || context?.sessionId);
  sockets.set(socket, { sessionId: session.sessionId });
  send(socket, { type: "session.ready", payload: { sessionId: session.sessionId } });

  if (message.type === "session.restore") {
    const requestedRoomCode = message.payload?.roomCode?.toUpperCase();
    if (session.roomCode && rooms.has(session.roomCode)) {
      const room = rooms.get(session.roomCode);
      const member = room.members.find((entry) => entry.sessionId === session.sessionId);
      if (member) {
        assignSocketToMember(socket, session, room, member);
        return;
      }
    }
    if (requestedRoomCode && rooms.has(requestedRoomCode)) {
      const room = rooms.get(requestedRoomCode);
      const member = room.members.find((entry) => entry.sessionId === session.sessionId);
      if (member) {
        assignSocketToMember(socket, session, room, member);
      }
    }
    return;
  }

  if (message.type === "room.create") {
    createRoom(socket, session, message.payload || {});
    return;
  }

  if (message.type === "room.join") {
    joinRoom(socket, session, message.payload || {});
    return;
  }

  if (!session.roomCode || !rooms.has(session.roomCode)) {
    sendError(socket, "Join a room first.");
    return;
  }

  const room = rooms.get(session.roomCode);
  const member = room.members.find((entry) => entry.sessionId === session.sessionId);
  if (!member) {
    sendError(socket, "Room membership missing.");
    return;
  }

  if (message.type === "room.leave") {
    detachFromRoom(session.sessionId, true);
    send(socket, {
      type: "room.snapshot",
      payload: {
        room: null,
        serverNow: Date.now()
      }
    });
    return;
  }

  if (message.type === "room.ready") {
    if (room.status !== "lobby" || member.sessionId === room.hostSessionId) {
      return;
    }
    member.ready = !member.ready;
    broadcastRoom(room);
    return;
  }

  if (message.type === "room.start") {
    if (member.sessionId !== room.hostSessionId) {
      sendError(socket, "Only the host can start the room.");
      return;
    }
    if (!canStartRoom(room)) {
      sendError(socket, "Room is not ready to start yet.");
      return;
    }
    startMatch(room);
    return;
  }

  if (message.type === "match.move") {
    applyAuthoritativeMove(room, member.sessionId, message.payload.row, message.payload.col, false);
  }
}

function encodeFrame(text) {
  const payload = Buffer.from(text);
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    throw new Error("Frame too large");
  }

  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) === 0x80;
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;

    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + payloadLength;
    if (offset + frameLength > buffer.length) break;

    if (opcode === 0x8) {
      return { messages, remaining: Buffer.alloc(0), shouldClose: true };
    }

    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + maskLength;
    const payload = Buffer.alloc(payloadLength);

    if (masked) {
      const mask = buffer.slice(maskOffset, maskOffset + 4);
      for (let index = 0; index < payloadLength; index += 1) {
        payload[index] = buffer[payloadOffset + index] ^ mask[index % 4];
      }
    } else {
      buffer.copy(payload, 0, payloadOffset, payloadOffset + payloadLength);
    }

    messages.push(payload.toString("utf8"));
    offset += frameLength;
  }

  return {
    messages,
    remaining: buffer.slice(offset),
    shouldClose: false
  };
}

function resolveFilePath(urlPath) {
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(WEB_ROOT, cleanPath));
  return filePath.startsWith(WEB_ROOT) ? filePath : null;
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const filePath = resolveFilePath(requestUrl.pathname);
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500);
      res.end(error.code === "ENOENT" ? "Not Found" : "Internal Server Error");
      return;
    }

    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n"
    ].join("\r\n")
  );

  sockets.set(socket, { sessionId: null });
  socket._frameBuffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    socket._frameBuffer = Buffer.concat([socket._frameBuffer, chunk]);
    const decoded = decodeFrames(socket._frameBuffer);
    socket._frameBuffer = decoded.remaining;

    decoded.messages.forEach((message) => handleMessage(socket, message));

    if (decoded.shouldClose) {
      socket.end();
    }
  });

  socket.on("close", () => {
    const context = getSocketContext(socket);
    if (context?.sessionId) {
      const session = sessions.get(context.sessionId);
      if (session?.roomCode && rooms.has(session.roomCode)) {
        const room = rooms.get(session.roomCode);
        const member = room.members.find((entry) => entry.sessionId === context.sessionId);
        if (member) {
          member.isConnected = false;
          member.socket = null;
          broadcastRoom(room);
        }
      }
    }
    sockets.delete(socket);
  });

  socket.on("error", () => {
    socket.destroy();
  });
});

server.listen(PORT, () => {
  console.log(`Chain Reaction Global realtime server running at http://localhost:${PORT}`);
});
