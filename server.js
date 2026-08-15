const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const rooms = new Map();

function makeRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(room, message) {
  room.players.forEach(player => send(player.ws, message));
}

function roomState(room) {
  return room.players.map((player, index) => ({
    id: player.id,
    name: player.name,
    host: index === 0
  }));
}

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  if (req.url === "/health") {
    res.end("Hunter of Villagers multiplayer server is healthy.");
  } else {
    res.end("Hunter of Villagers multiplayer server is running.");
  }
});

const wss = new WebSocket.Server({
  server: httpServer
});

wss.on("connection", ws => {
  const player = {
    id: Math.random().toString(36).slice(2, 10),
    name: "Player",
    ws,
    roomCode: null
  };

  send(ws, {
    type: "connected",
    playerId: player.id
  });

  ws.on("message", raw => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, {
        type: "error",
        message: "Invalid message."
      });
      return;
    }

    // HOST CREATES ROOM
    if (message.type === "createRoom") {
      const code = makeRoomCode();

      const room = {
        code,
        state: "lobby",
        selectedLevel: null,
        players: [player]
      };

      player.roomCode = code;
      player.name = String(
        message.name || "Player 1"
      ).slice(0, 20);

      rooms.set(code, room);

      send(ws, {
        type: "roomCreated",
        roomCode: code,
        isHost: true,
        players: roomState(room)
      });

      return;
    }

    // PLAYER JOINS ROOM
    if (message.type === "joinRoom") {
      const code = String(
        message.roomCode || ""
      ).trim().toUpperCase();

      const room = rooms.get(code);

      if (!room) {
        send(ws, {
          type: "error",
          message: "Room not found."
        });
        return;
      }

      if (room.state !== "lobby") {
        send(ws, {
          type: "error",
          message: "That game has already started."
        });
        return;
      }

      player.roomCode = code;

      player.name = String(
        message.name ||
        "Player " + (room.players.length + 1)
      ).slice(0, 20);

      room.players.push(player);

      broadcast(room, {
        type: "lobbyUpdate",
        players: roomState(room)
      });

      return;
    }

    const room = player.roomCode
      ? rooms.get(player.roomCode)
      : null;

    if (!room) {
      send(ws, {
        type: "error",
        message: "You are not in a room."
      });
      return;
    }

    // HOST STARTS THE GAME
    if (message.type === "startGame") {
      if (room.players[0] !== player) {
        send(ws, {
          type: "error",
          message: "Only the host can start the game."
        });
        return;
      }

      room.state = "selectingLevel";

      broadcast(room, {
        type: "hostStarted",
        hostId: player.id
      });

      return;
    }

    // HOST SELECTS LEVEL
    if (message.type === "selectLevel") {
      if (room.players[0] !== player) {
        send(ws, {
          type: "error",
          message: "Only the host can select the level."
        });
        return;
      }

      room.selectedLevel =
        message.level || "village";

      room.state = "playing";

      broadcast(room, {
        type: "gameStarted",
        level: room.selectedLevel
      });

      return;
    }

    // PLAYER POSITION UPDATE
    if (message.type === "playerUpdate") {
      room.players.forEach(other => {
        if (other !== player) {
          send(other.ws, {
            type: "playerUpdate",
            playerId: player.id,
            data: message.data || {}
          });
        }
      });
    }
  });

  ws.on("close", () => {
    if (!player.roomCode) {
      return;
    }

    const room = rooms.get(player.roomCode);

    if (!room) {
      return;
    }

    room.players =
      room.players.filter(
        other => other !== player
      );

    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      broadcast(room, {
        type: "lobbyUpdate",
        players: roomState(room)
      });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(
    "Hunter of Villagers multiplayer server running on port " +
    PORT
  );
});
