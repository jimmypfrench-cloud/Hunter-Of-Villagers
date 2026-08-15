const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const HOST = "0.0.0.0";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hunter of Villagers multiplayer server is running.");
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();

function send(ws, type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type,
      ...data
    }));
  }
}

function broadcast(room, type, data = {}, except = null) {
  if (!room) return;

  for (const player of room.players) {
    if (player !== except) {
      send(player.ws, type, data);
    }
  }
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      players: [],
      host: null,
      gameStarted: false,
      paused: false
    });
  }

  return rooms.get(roomId);
}

function lobbyUpdate(room) {
  if (!room) return;

  const players = room.players.map(p => ({
    id: p.id,
    name: p.name,
    host: p === room.host,
    dead: !!p.dead
  }));

  broadcast(room, "lobbyUpdate", {
    players,
    playerCount: players.length,
    hostId: room.host ? room.host.id : null,
    gameStarted: room.gameStarted
  });
}

function removePlayer(player) {
  const room = player.room;

  if (!room) return;

  const index = room.players.indexOf(player);

  if (index !== -1) {
    room.players.splice(index, 1);
  }

  broadcast(room, "playerLeft", {
    playerId: player.id
  });

  if (room.host === player) {
    room.host = room.players[0] || null;

    if (room.host) {
      room.host.isHost = true;

      broadcast(room, "hostChanged", {
        playerId: room.host.id
      });
    }
  }

  if (room.players.length === 0) {
    rooms.delete(room.id);
  } else {
    lobbyUpdate(room);
  }

  player.room = null;
}

wss.on("connection", ws => {

  const player = {
    ws,
    id: Math.random().toString(36).substring(2, 10),
    name: "Player",
    room: null,
    isHost: false,
    dead: false,

    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,

    loadout: null
  };

  send(ws, "connected", {
    playerId: player.id
  });

  ws.on("message", raw => {

    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const type = msg.type;

    // =========================
    // JOIN
    // =========================

    if (type === "join") {

      const roomId = String(msg.roomId || "default");
      const room = getRoom(roomId);

      if (room.players.length >= 4) {
        send(ws, "roomFull");
        return;
      }

      player.name =
        String(msg.name || `Player ${room.players.length + 1}`);

      player.room = room;
      player.isHost = room.players.length === 0;

      room.players.push(player);

      if (!room.host) {
        room.host = player;
      }

      send(ws, "joined", {
        playerId: player.id,
        host: player === room.host,
        playerCount: room.players.length,
        gameStarted: room.gameStarted
      });

      lobbyUpdate(room);

      return;
    }

    const room = player.room;

    if (!room) return;

    // =========================
    // PLAYER UPDATE
    // =========================

    if (type === "playerUpdate") {

      player.x = Number(msg.x) || 0;
      player.y = Number(msg.y) || 0;
      player.z = Number(msg.z) || 0;

      player.yaw = Number(msg.yaw) || 0;
      player.pitch = Number(msg.pitch) || 0;

      if (typeof msg.dead === "boolean") {
        player.dead = msg.dead;
      }

      if (msg.loadout) {
        player.loadout = msg.loadout;
      }

      broadcast(room, "playerUpdate", {
        playerId: player.id,

        x: player.x,
        y: player.y,
        z: player.z,

        yaw: player.yaw,
        pitch: player.pitch,

        dead: player.dead,

        host: player === room.host,

        // Only host loadout is authoritative.
        loadout:
          player === room.host
            ? player.loadout
            : undefined

      }, player);

      return;
    }

    // =========================
    // START GAME
    // =========================

    if (type === "startGame") {

      if (player !== room.host) return;

      room.gameStarted = true;
      room.paused = false;

      broadcast(room, "startGame", {
        hostId: room.host.id
      });

      lobbyUpdate(room);

      return;
    }

    // =========================
    // SELECT LEVEL
    // =========================

    if (type === "selectLevel") {

      if (player !== room.host) return;

      broadcast(room, "selectLevel", {
        level: msg.level
      });

      return;
    }

    // =========================
    // WORLD SNAPSHOT
    // =========================

    if (type === "worldSnapshot") {

      if (player !== room.host) return;

      broadcast(room, "worldSnapshot", {
        villagers: msg.villagers || [],
        allies: msg.allies || [],
        gold: msg.gold,
        timestamp: msg.timestamp || Date.now()
      }, player);

      return;
    }

    // =========================
    // VILLAGER HIT
    // =========================

    if (type === "villagerHit") {

      if (player === room.host) return;

      if (!room.host) return;

      send(room.host.ws, "villagerHit", {
        playerId: player.id,
        index: msg.index,
        damage: msg.damage
      });

      return;
    }

    // =========================
    // VILLAGER DIED
    // =========================

    if (type === "villagerDied") {

      if (player !== room.host) return;

      broadcast(room, "villagerDied", {
        index: msg.index,
        byPlayerId: msg.byPlayerId || player.id
      }, player);

      return;
    }

    // =========================
    // DAMAGE PLAYER
    // =========================

    if (type === "damagePlayer") {

      if (player !== room.host) return;

      const target = room.players.find(
        p => p.id === msg.targetPlayerId
      );

      if (!target) return;

      send(target.ws, "damagePlayer", {
        amount: Number(msg.amount) || 0,
        sourceId: player.id
      });

      return;
    }

    // =========================
    // PLAYER DIED
    // =========================

    if (type === "playerDied") {

      player.dead = true;

      broadcast(room, "playerDied", {
        playerId: player.id
      });

      lobbyUpdate(room);

      return;
    }

    // =========================
    // PLAYER REVIVED
    // =========================

    if (type === "playerRevived") {

      player.dead = false;

      broadcast(room, "playerRevived", {
        playerId: player.id
      });

      lobbyUpdate(room);

      return;
    }

    // =========================
    // PAUSE
    // =========================

    if (type === "pauseGame") {

      if (!room.gameStarted) return;

      room.paused = true;

      // IMPORTANT:
      // Send pause to EVERY other player.
      broadcast(room, "pauseGame", {
        playerId: player.id
      }, player);

      return;
    }

    // =========================
    // RESUME
    // =========================

    if (type === "resumeGame") {

      if (!room.gameStarted) return;

      room.paused = false;

      // IMPORTANT:
      // Send resume to EVERY other player.
      broadcast(room, "resumeGame", {
        playerId: player.id
      }, player);

      return;
    }

    // =========================
    // DEPOSIT GOLD
    // =========================

    if (type === "depositGold") {

      if (player === room.host) return;

      if (!room.host) return;

      send(room.host.ws, "depositGold", {
        playerId: player.id,
        amount: Number(msg.amount) || 0
      });

      return;
    }

    // =========================
    // RAID REWARDS READY
    // =========================

    if (type === "raidRewardsReady") {

      if (player !== room.host) return;

      broadcast(room, "raidRewardsReady", {
        loadout: msg.loadout || null,
        gold: Number(msg.gold) || 0
      }, player);

      return;
    }

    // =========================
    // RAID ENDED
    // =========================

    if (type === "raidEnded") {

      if (player !== room.host) return;

      room.gameStarted = false;
      room.paused = false;

      broadcast(room, "raidEnded", {
        reason: msg.reason || "complete"
      });

      lobbyUpdate(room);

      return;
    }

    // =========================
    // FINALE CONTINUE
    // =========================

    if (type === "finaleContinue") {

      if (player !== room.host) return;

      broadcast(room, "finaleContinue", {
        loadout: msg.loadout || null,
        gold: Number(msg.gold) || 0
      }, player);

      return;
    }

    // =========================
    // GENERIC BROADCAST
    // =========================

    if (type === "broadcast") {

      broadcast(
        room,
        msg.messageType,
        msg.payload || {},
        player
      );

      return;
    }
  });

  ws.on("close", () => {
    removePlayer(player);
  });

  ws.on("error", () => {
    removePlayer(player);
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    `Hunter of Villagers multiplayer server running on ${HOST}:${PORT}`
  );
});
