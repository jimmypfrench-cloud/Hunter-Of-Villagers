const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS_PER_ROOM = 6;

const rooms = new Map();

function makeRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(room, message) {
  if (!room) return;

  for (const player of room.players) {
    send(player.ws, message);
  }
}

function broadcastExcept(room, exceptPlayer, message) {
  if (!room) return;

  for (const player of room.players) {
    if (player !== exceptPlayer) {
      send(player.ws, message);
    }
  }
}

function getRoomPlayers(room) {
  return room.players.map((player, index) => ({
    id: player.id,
    name: player.name,
    host: index === 0,
    dead: !!player.dead,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw
  }));
}

function bumpRound(room) {
  room.roundId = (room.roundId || 0) + 1;
}

function validRoundMessage(room, message) {
  if (
    message.roundId === undefined ||
    message.roundId === null
  ) {
    return true;
  }

  return Number(message.roundId) === Number(room.roundId);
}

/* =========================================================
   HTTP SERVER
   ========================================================= */

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    res.end("Hunter of Villagers multiplayer server is healthy.");
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    const indexPath = path.join(__dirname, "index.html");

    fs.readFile(indexPath, (error, data) => {
      if (error) {
        console.error("Could not load index.html:", error);

        res.writeHead(500, {
          "Content-Type": "text/plain"
        });

        res.end("ERROR: index.html could not be found.");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8"
      });

      res.end(data);
    });

    return;
  }

  res.writeHead(404, {
    "Content-Type": "text/plain"
  });

  res.end("Not found.");
});

/* =========================================================
   WEBSOCKET SERVER
   ========================================================= */

const wss = new WebSocket.Server({
  server: httpServer
});

wss.on("connection", (ws) => {
  const player = {
    id: Math.random().toString(36).slice(2, 10),
    name: "Player",
    ws,
    roomCode: null,

    x: 0,
    y: 0,
    z: 0,
    yaw: 0,

    dead: false,
    loadout: null
  };

  send(ws, {
    type: "connected",
    playerId: player.id
  });

  ws.on("message", (raw) => {
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

    if (!message || typeof message.type !== "string") {
      send(ws, {
        type: "error",
        message: "Invalid message type."
      });
      return;
    }

    /* =====================================================
       CREATE ROOM
       ===================================================== */

    if (message.type === "createRoom") {
      if (player.roomCode) {
        send(ws, {
          type: "error",
          message: "You are already in a room."
        });
        return;
      }

      const code = makeRoomCode();

      const room = {
        code,

        state: "lobby",
        selectedLevel: null,
        paused: false,

        roundEnding: false,
        depositedIds: new Set(),

        roundId: 0,

        /*
         * Cached authoritative state.
         * This is useful if the host disconnects and
         * another player becomes host.
         */
        worldSnapshot: null,
        allySnapshot: null,

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
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        players: getRoomPlayers(room),
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       JOIN ROOM
       ===================================================== */

    if (message.type === "joinRoom") {
      if (player.roomCode) {
        send(ws, {
          type: "error",
          message: "You are already in a room."
        });
        return;
      }

      const code = String(
        message.roomCode || ""
      )
        .trim()
        .toUpperCase();

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

      if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
        send(ws, {
          type: "error",
          message: `Room is full. Maximum ${MAX_PLAYERS_PER_ROOM} players.`
        });
        return;
      }

      player.roomCode = code;
      player.name = String(
        message.name ||
        `Player ${room.players.length + 1}`
      ).slice(0, 20);

      room.players.push(player);

      send(ws, {
        type: "joinedRoom",
        roomCode: room.code,
        isHost: room.players[0] === player,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        roundId: room.roundId,
        players: getRoomPlayers(room)
      });

      broadcast(room, {
        type: "lobbyUpdate",
        roundId: room.roundId,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        players: getRoomPlayers(room)
      });

      return;
    }

    /* =====================================================
       ROOM LOOKUP
       ===================================================== */

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

    /* =====================================================
       PAUSE
       ===================================================== */

    if (message.type === "pauseGame") {
      if (room.state !== "playing") return;
      if (room.roundEnding) return;
      if (!validRoundMessage(room, message)) return;

      room.paused = true;

      broadcast(room, {
        type: "pauseGame",
        playerId: player.id,
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       RESUME
       ===================================================== */

    if (message.type === "resumeGame") {
      if (room.state !== "playing") return;
      if (room.roundEnding) return;
      if (!validRoundMessage(room, message)) return;

      room.paused = false;

      broadcast(room, {
        type: "resumeGame",
        playerId: player.id,
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       HOST START GAME
       ===================================================== */

    if (message.type === "startGame") {
      if (room.players[0] !== player) {
        send(ws, {
          type: "error",
          message: "Only the host can start the game."
        });
        return;
      }

      if (room.state !== "lobby") return;

      if (room.players.length < 2) {
        send(ws, {
          type: "error",
          message: "Waiting for another player."
        });
        return;
      }

      room.state = "selectingLevel";
      room.paused = false;
      room.roundEnding = false;
      room.depositedIds.clear();

      broadcast(room, {
        type: "hostStarted",
        hostId: player.id,
        roundId: room.roundId,
        playerCount: room.players.length
      });

      return;
    }

    /* =====================================================
       HOST SELECT LEVEL
       ===================================================== */

    if (message.type === "selectLevel") {
      if (room.players[0] !== player) {
        send(ws, {
          type: "error",
          message: "Only the host can select the level."
        });
        return;
      }

      if (
        room.state !== "selectingLevel" &&
        room.state !== "lobby"
      ) {
        return;
      }

      if (
        message.level === undefined ||
        message.level === null
      ) {
        send(ws, {
          type: "error",
          message: "No level was selected."
        });
        return;
      }

      room.selectedLevel = message.level;
      room.state = "playing";
      room.paused = false;
      room.roundEnding = false;
      room.depositedIds.clear();

      room.worldSnapshot = null;
      room.allySnapshot = null;

      for (const p of room.players) {
        p.dead = false;
      }

      bumpRound(room);

      broadcast(room, {
        type: "gameStarted",
        level: room.selectedLevel,
        roundId: room.roundId,
        players: getRoomPlayers(room)
      });

      return;
    }

    /* =====================================================
       HOST LOADOUT
       ===================================================== */

    if (message.type === "hostLoadout") {
      if (room.players[0] !== player) return;
      if (!validRoundMessage(room, message)) return;

      player.loadout = message.loadout || null;

      broadcastExcept(room, player, {
        type: "hostLoadout",
        loadout: player.loadout,
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       BOSS TRIGGER
       ===================================================== */

    if (message.type === "reachedBoss") {
      if (room.state !== "playing") return;
      if (room.roundEnding) return;
      if (!validRoundMessage(room, message)) return;

      if (
        message.boss !== "wizard" &&
        message.boss !== "warlord"
      ) {
        return;
      }

      const host = room.players[0];

      if (!host || host === player) return;

      send(host.ws, {
        type: "reachedBoss",
        playerId: player.id,
        boss: message.boss,
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       BOSS SPAWNED
       ===================================================== */

    if (message.type === "bossSpawned") {
      if (room.state !== "playing") return;
      if (room.roundEnding) return;
      if (!validRoundMessage(room, message)) return;

      if (room.players[0] !== player) return;

      if (
        message.boss !== "wizard" &&
        message.boss !== "warlord"
      ) {
        return;
      }

      broadcastExcept(room, player, {
        type: "bossSpawned",
        boss: message.boss,
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       PLAYER UPDATE
       ===================================================== */

    if (message.type === "playerUpdate") {
      if (room.state !== "playing") return;
      if (room.roundEnding) return;
      if (!validRoundMessage(room, message)) return;

      const data = message.data || {};

      if (Number.isFinite(Number(data.x))) {
        player.x = Number(data.x);
      }

      if (Number.isFinite(Number(data.y))) {
        player.y = Number(data.y);
      }

      if (Number.isFinite(Number(data.z))) {
        player.z = Number(data.z);
      }

      if (Number.isFinite(Number(data.yaw))) {
        player.yaw = Number(data.yaw);
      }

      if (typeof data.dead === "boolean") {
        player.dead = data.dead;
      }

      if (data.loadout) {
        player.loadout = data.loadout;
      }

      const outgoing = {
        type: "playerUpdate",
        playerId: player.id,

        data: {
          x: player.x,
          y: player.y,
          z: player.z,
          yaw: player.yaw,
          health: Number.isFinite(Number(data.health))
            ? Number(data.health)
            : undefined,
          name: player.name,
          dead: player.dead
        },

        roundId: room.roundId
      };

      /*
       * Only the host is authoritative for the shared world.
       */
      if (
        room.players[0] === player &&
        data.worldSnapshot
      ) {
        room.worldSnapshot = data.worldSnapshot;

        if (data.allySnapshot) {
          room.allySnapshot = data.allySnapshot;
        }

        outgoing.data.worldSnapshot =
          room.worldSnapshot;

        outgoing.data.allySnapshot =
          room.allySnapshot;

        outgoing.data.worldLevel =
          data.worldLevel;
      }

      broadcastExcept(room, player, outgoing);

      return;
    }

    /* =====================================================
       PLAYER DIED
       ===================================================== */

    if (message.type === "playerDied") {
      if (room.state !== "playing") return;
      if (!validRoundMessage(room, message)) return;

      player.dead = true;

      broadcast(room, {
        type: "playerDied",
        roundId: room.roundId,
        playerId: player.id
      });

      return;
    }

    /* =====================================================
       PLAYER REVIVED
       ===================================================== */

    if (message.type === "playerRevived") {
      if (room.state !== "playing") return;
      if (!validRoundMessage(room, message)) return;

      player.dead = false;

      broadcast(room, {
        type: "playerRevived",
        roundId: room.roundId,
        playerId: player.id
      });

      return;
    }

    /* =====================================================
       PLAYER DAMAGE
       ===================================================== */

    if (message.type === "damagePlayer") {
      if (room.state !== "playing") return;
      if (room.roundEnding) return;
      if (!validRoundMessage(room, message)) return;

      const targetId = String(
        message.targetId || ""
      );

      const target = room.players.find(
        p => p.id === targetId
      );

      if (!target) return;

      let amount = Number(message.amount);

      if (!Number.isFinite(amount)) return;

      amount = Math.max(
        0,
        Math.min(10000, amount)
      );

      send(target.ws, {
        type: "damagePlayer",
        targetId: target.id,
        amount,
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       VILLAGER HIT
       ===================================================== */

    if (message.type === "villagerHit") {
      if (room.state !== "playing") return;
      if (room.roundEnding) return;
      if (!validRoundMessage(room, message)) return;

      /*
       * Guests report hits to the host.
       * The host remains authoritative over villagers.
       */
      if (room.players[0] !== player) {
        const host = room.players[0];

        if (!host) return;

        let index = Number(message.index);
        let dmg = Number(message.dmg);

        if (!Number.isInteger(index) || index < 0) {
          return;
        }

        if (!Number.isFinite(dmg) || dmg <= 0) {
          return;
        }

        dmg = Math.min(10000, dmg);

        send(host.ws, {
          type: "villagerHit",
          index,
          dmg,
          playerId: player.id,
          roundId: room.roundId
        });

        return;
      }

      /*
       * Host's own hit is simply forwarded to guests.
       */
      broadcastExcept(room, player, {
        type: "villagerHit",
        index: Number(message.index),
        dmg: Number(message.dmg),
        playerId: player.id,
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       DEPOSIT GOLD
       ===================================================== */

    if (message.type === "depositGold") {
      if (
        room.state !== "selectingLevel" ||
        !room.roundEnding
      ) {
        return;
      }

      if (!validRoundMessage(room, message)) {
        return;
      }

      const host = room.players[0];

      if (!host || host === player) return;

      /*
       * Each player may deposit only once per round.
       */
      if (room.depositedIds.has(player.id)) {
        return;
      }

      room.depositedIds.add(player.id);

      let amount = Number(message.amount);

      if (!Number.isFinite(amount)) {
        amount = 0;
      }

      amount = Math.max(
        0,
        Math.min(1000000, Math.floor(amount))
      );

      send(host.ws, {
        type: "depositGold",
        playerId: player.id,
        amount,
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       RAID REWARDS READY
       ===================================================== */

    if (message.type === "raidRewardsReady") {
      if (room.players[0] !== player) return;
      if (!validRoundMessage(room, message)) return;

      if (
        room.state !== "selectingLevel" ||
        !room.roundEnding
      ) {
        return;
      }

      room.roundEnding = false;

      broadcastExcept(room, player, {
        type: "raidRewardsReady",
        result: message.result || "win",
        message:
          message.message ||
          "Raid rewards received.",
        loadout: message.loadout || null,
        gold: Number(message.gold) || 0,
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       RAID ENDED
       ===================================================== */

    if (message.type === "raidEnded") {
      if (room.players[0] !== player) return;
      if (room.state !== "playing") return;

      room.state = "selectingLevel";
      room.paused = false;
      room.selectedLevel = null;

      room.roundEnding = true;
      room.depositedIds.clear();

      /*
       * The host has already handled its own reward.
       */
      room.depositedIds.add(player.id);

      for (const p of room.players) {
        p.dead = false;
      }

      bumpRound(room);

      broadcast(room, {
        type: "raidEnded",
        result: message.result || "dead",
        message:
          message.message ||
          (
            message.result === "win"
              ? "Raid cleared."
              : "The hunting party has fallen."
          ),
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       FINALE CONTINUE
       ===================================================== */

    if (message.type === "finaleContinue") {
      if (room.players[0] !== player) return;
      if (!validRoundMessage(room, message)) return;

      broadcastExcept(room, player, {
        type: "finaleContinue",
        loadout: message.loadout || null,
        gold: Number(message.gold) || 0,
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       WORLD SNAPSHOT
       ===================================================== */

    if (message.type === "worldSnapshot") {
      if (room.state !== "playing") return;
      if (room.roundEnding) return;
      if (!validRoundMessage(room, message)) return;

      if (room.players[0] !== player) return;

      room.worldSnapshot =
        message.villagers || [];

      room.allySnapshot =
        message.allies || [];

      broadcastExcept(room, player, {
        type: "worldSnapshot",
        villagers: room.worldSnapshot,
        allies: room.allySnapshot,
        gold: message.gold,
        timestamp:
          message.timestamp || Date.now(),
        worldLevel: message.worldLevel,
        roundId: room.roundId
      });

      return;
    }

    /* =====================================================
       GENERIC BROADCAST
       ===================================================== */

    if (message.type === "broadcast") {
      if (!validRoundMessage(room, message)) {
        return;
      }

      broadcastExcept(room, player, {
        type: message.messageType,
        payload: message.payload || {},
        playerId: player.id,
        roundId: room.roundId
      });

      return;
    }
  });

  /* =======================================================
     DISCONNECT
     ======================================================= */

  ws.on("close", () => {
    if (!player.roomCode) return;

    const room = rooms.get(player.roomCode);

    if (!room) return;

    const wasHost = room.players[0] === player;

    room.players = room.players.filter(
      p => p !== player
    );

    room.depositedIds.delete(player.id);

    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }

    /*
     * If the host disconnects, player 2 becomes host.
     */
    if (wasHost) {
      /*
       * The current room state is preserved.
       * The new host can continue from the same round.
       */
      broadcast(room, {
        type: "hostChanged",
        hostId: room.players[0].id,
        state: room.state,
        selectedLevel: room.selectedLevel,
        paused: room.paused,
        roundEnding: !!room.roundEnding,
        roundId: room.roundId,

        worldSnapshot:
          room.worldSnapshot,

        allySnapshot:
          room.allySnapshot
      });
    } else {
      broadcast(room, {
        type: "playerDisconnected",
        playerId: player.id,
        roundId: room.roundId
      });
    }

    broadcast(room, {
      type: "lobbyUpdate",
      roundId: room.roundId,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      players: getRoomPlayers(room)
    });
  });
});

/* =========================================================
   START SERVER
   ========================================================= */

httpServer.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "Hunter of Villagers multiplayer server running on port " +
      PORT +
      " | Maximum players per room: " +
      MAX_PLAYERS_PER_ROOM
    );
  }
);
