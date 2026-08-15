const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS_PER_ROOM = 4;

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

/* ==================================================
   SERVE THE GAME
   ================================================== */

const httpServer = http.createServer((req, res) => {

  // Render health check
  if (req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "text/plain"
    });

    res.end(
      "Hunter of Villagers multiplayer server is healthy."
    );

    return;
  }

  // Serve index.html
  if (
    req.url === "/" ||
    req.url === "/index.html"
  ) {
    const indexPath = path.join(__dirname, "index.html");

    fs.readFile(indexPath, (error, data) => {

      if (error) {
        console.error(
          "Could not load index.html:",
          error
        );

        res.writeHead(500, {
          "Content-Type": "text/plain"
        });

        res.end(
          "ERROR: index.html could not be found."
        );

        return;
      }

      res.writeHead(200, {
        "Content-Type":
          "text/html; charset=utf-8"
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


/* ==================================================
   WEBSOCKET SERVER
   ================================================== */

const wss = new WebSocket.Server({
  server: httpServer
});


wss.on("connection", (ws) => {

  const player = {
    id: Math.random()
      .toString(36)
      .slice(2, 10),

    name: "Player",

    ws: ws,

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
      message = JSON.parse(
        raw.toString()
      );
    } catch (error) {

      send(ws, {
        type: "error",
        message: "Invalid message."
      });

      return;
    }


    /* ================================================
       CREATE ROOM
       ================================================ */

    if (message.type === "createRoom") {

      const code = makeRoomCode();

      const room = {
        code: code,

        state: "lobby",

        selectedLevel: null,

        paused: false,

        players: [
          player
        ]
      };

      player.roomCode = code;

      player.name =
        String(
          message.name ||
          "Player 1"
        ).slice(0, 20);

      rooms.set(
        code,
        room
      );

      send(ws, {
        type: "roomCreated",

        roomCode: code,

        isHost: true,

        players:
          getRoomPlayers(room)
      });

      return;
    }


    /* ================================================
       JOIN ROOM
       ================================================ */

    if (message.type === "joinRoom") {

      const code =
        String(
          message.roomCode || ""
        )
        .trim()
        .toUpperCase();

      const room =
        rooms.get(code);


      if (!room) {

        send(ws, {
          type: "error",
          message:
            "Room not found."
        });

        return;
      }


      if (room.state !== "lobby") {

        send(ws, {
          type: "error",
          message:
            "That game has already started."
        });

        return;
      }


      if (
        room.players.length >=
        MAX_PLAYERS_PER_ROOM
      ) {

        send(ws, {
          type: "error",
          message:
            "Room is full. Maximum 4 players."
        });

        return;
      }


      player.roomCode = code;

      player.name =
        String(
          message.name ||
          `Player ${room.players.length + 1}`
        ).slice(0, 20);

      room.players.push(
        player
      );


      broadcast(room, {
        type: "lobbyUpdate",

        players:
          getRoomPlayers(room)
      });

      return;
    }


    /* ================================================
       FIND PLAYER ROOM
       ================================================ */

    const room =
      player.roomCode
        ? rooms.get(
            player.roomCode
          )
        : null;


    if (!room) {

      send(ws, {
        type: "error",
        message:
          "You are not in a room."
      });

      return;
    }


    /* ================================================
       PAUSE GAME
       ================================================ */

    if (message.type === "pauseGame") {

      room.paused = true;

      // Pause every other connected player.
      broadcastExcept(room, player, {
        type: "pauseGame",
        playerId: player.id
      });

      return;
    }


    /* ================================================
       RESUME GAME
       ================================================ */

    if (message.type === "resumeGame") {

      room.paused = false;

      // Resume every other connected player.
      broadcastExcept(room, player, {
        type: "resumeGame",
        playerId: player.id
      });

      return;
    }


    /* ================================================
       HOST STARTS GAME
       ================================================ */

    if (
      message.type === "startGame"
    ) {

      if (
        room.players[0] !== player
      ) {

        send(ws, {
          type: "error",
          message:
            "Only the host can start the game."
        });

        return;
      }


      if (
        room.players.length < 2
      ) {

        send(ws, {
          type: "error",
          message:
            "Waiting for another player."
        });

        return;
      }


      room.state =
        "selectingLevel";

      room.paused = false;


      broadcast(room, {
        type: "hostStarted",

        hostId:
          player.id
      });

      return;
    }


    /* ================================================
       HOST SELECTS LEVEL
       ================================================ */

    if (
      message.type ===
      "selectLevel"
    ) {

      if (
        room.players[0] !== player
      ) {

        send(ws, {
          type: "error",
          message:
            "Only the host can select the level."
        });

        return;
      }


      if (
        message.level ===
        undefined ||
        message.level === null
      ) {

        send(ws, {
          type: "error",
          message:
            "No level was selected."
        });

        return;
      }


      room.selectedLevel =
        message.level;

      room.state =
        "playing";

      room.paused = false;


      broadcast(room, {
        type: "gameStarted",

        level:
          room.selectedLevel
      });

      return;
    }


    /* ================================================
       VILLAGER / GUARD HIT
       Non-host -> host
       ================================================ */

    if (
      message.type ===
      "villagerHit"
    ) {

      const host =
        room.players[0];

      if (
        host &&
        host !== player
      ) {

        send(host.ws, {
          type: "villagerHit",

          playerId:
            player.id,

          index:
            message.index,

          dmg:
            message.dmg
        });
      }

      return;
    }


    /* ================================================
       VILLAGER DIED
       Host -> everyone else
       ================================================ */

    if (
      message.type ===
      "villagerDied"
    ) {

      if (
        room.players[0] !== player
      ) {
        return;
      }

      broadcastExcept(room, player, {
        type: "villagerDied",

        index:
          message.index,

        playerId:
          player.id
      });

      return;
    }


    /* ================================================
       DAMAGE PLAYER
       Host -> specific player
       ================================================ */

    if (
      message.type ===
      "damagePlayer"
    ) {

      if (
        room.players[0] !== player
      ) {
        return;
      }

      const target =
        room.players.find(
          p =>
            p.id ===
            message.targetId
        );


      if (target) {

        send(target.ws, {
          type: "damagePlayer",

          amount:
            message.amount
        });
      }

      return;
    }


    /* ================================================
       PLAYER UPDATE
       ================================================ */

    if (
      message.type ===
      "playerUpdate"
    ) {

      const data =
        message.data || {};


      if (
        Number.isFinite(
          Number(data.x)
        )
      ) {
        player.x =
          Number(data.x);
      }


      if (
        Number.isFinite(
          Number(data.y)
        )
      ) {
        player.y =
          Number(data.y);
      }


      if (
        Number.isFinite(
          Number(data.z)
        )
      ) {
        player.z =
          Number(data.z);
      }


      if (
        Number.isFinite(
          Number(data.yaw)
        )
      ) {
        player.yaw =
          Number(data.yaw);
      }


      if (
        typeof data.dead ===
        "boolean"
      ) {
        player.dead =
          data.dead;
      }


      if (data.loadout) {
        player.loadout =
          data.loadout;
      }


      broadcastExcept(
        room,
        player,
        {
          type:
            "playerUpdate",

          playerId:
            player.id,

          data:
            data,

          dead:
            player.dead
        }
      );

      return;
    }


    /* ================================================
       PLAYER DIED
       ================================================ */

    if (
      message.type ===
      "playerDied"
    ) {

      player.dead = true;


      broadcast(room, {
        type: "playerDied",

        playerId:
          player.id
      });


      broadcast(room, {
        type: "lobbyUpdate",

        players:
          getRoomPlayers(room)
      });

      return;
    }


    /* ================================================
       PLAYER REVIVED
       ================================================ */

    if (
      message.type ===
      "playerRevived"
    ) {

      player.dead = false;


      broadcast(room, {
        type: "playerRevived",

        playerId:
          player.id
      });


      broadcast(room, {
        type: "lobbyUpdate",

        players:
          getRoomPlayers(room)
      });

      return;
    }


    /* ================================================
       DEPOSIT GOLD
       Non-host -> host
       ================================================ */

    if (
      message.type ===
      "depositGold"
    ) {

      const host =
        room.players[0];

      if (
        host &&
        host !== player
      ) {

        send(host.ws, {
          type: "depositGold",

          playerId:
            player.id,

          amount:
            Number(message.amount) || 0
        });
      }

      return;
    }


    /* ================================================
       RAID REWARDS READY
       Host -> everyone else
       ================================================ */

    if (
      message.type ===
      "raidRewardsReady"
    ) {

      if (
        room.players[0] !== player
      ) {
        return;
      }


      broadcastExcept(room, player, {
        type:
          "raidRewardsReady",

        loadout:
          message.loadout || null,

        gold:
          Number(message.gold) || 0
      });

      return;
    }


    /* ================================================
       RAID ENDED
       ================================================ */

    if (
      message.type ===
      "raidEnded"
    ) {

      if (
        room.players[0] !== player
      ) {
        return;
      }


      room.state =
        "lobby";

      room.paused =
        false;

      room.selectedLevel =
        null;


      broadcast(room, {
        type: "raidEnded",

        reason:
          message.reason ||
          "complete"
      });


      broadcast(room, {
        type: "lobbyUpdate",

        players:
          getRoomPlayers(room)
      });

      return;
    }


    /* ================================================
       FINALE CONTINUE
       ================================================ */

    if (
      message.type ===
      "finaleContinue"
    ) {

      if (
        room.players[0] !== player
      ) {
        return;
      }


      broadcastExcept(room, player, {
        type:
          "finaleContinue",

        loadout:
          message.loadout || null,

        gold:
          Number(message.gold) || 0
      });

      return;
    }


    /* ================================================
       WORLD SNAPSHOT
       Host -> everyone else
       ================================================ */

    if (
      message.type ===
      "worldSnapshot"
    ) {

      if (
        room.players[0] !== player
      ) {
        return;
      }


      broadcastExcept(room, player, {
        type:
          "worldSnapshot",

        villagers:
          message.villagers || [],

        allies:
          message.allies || [],

        gold:
          message.gold,

        timestamp:
          message.timestamp ||
          Date.now()
      });

      return;
    }


    /* ================================================
       GENERIC BROADCAST
       ================================================ */

    if (
      message.type ===
      "broadcast"
    ) {

      broadcastExcept(
        room,
        player,
        {
          type:
            message.messageType,

          payload:
            message.payload || {}
        }
      );

      return;
    }

  });


  /* ==================================================
     PLAYER DISCONNECT
     ================================================== */

  ws.on("close", () => {

    if (!player.roomCode) {
      return;
    }


    const room =
      rooms.get(
        player.roomCode
      );


    if (!room) {
      return;
    }


    room.players =
      room.players.filter(
        p => p !== player
      );


    if (
      room.players.length === 0
    ) {

      rooms.delete(
        room.code
      );

      return;
    }


    // If host disconnected, the next
    // player becomes host.
    broadcast(room, {
      type: "hostChanged",

      hostId:
        room.players[0].id
    });


    broadcast(room, {
      type: "lobbyUpdate",

      players:
        getRoomPlayers(room)
    });

  });

});


/* ==================================================
   START SERVER
   ================================================== */

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
