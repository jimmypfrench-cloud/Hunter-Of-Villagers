const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const rooms = new Map();

function makeRoomCode() {
  let code;

  do {
    code = Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase();
  } while (rooms.has(code));

  return code;
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(room, message) {
  for (const player of room.players) {
    send(player.ws, message);
  }
}

function getRoomPlayers(room) {
  return room.players.map((player, index) => ({
    id: player.id,
    name: player.name,
    host: index === 0
  }));
}


// --------------------------------------------------
// HTTP SERVER
// --------------------------------------------------

const httpServer = http.createServer((req, res) => {

  res.writeHead(200, {
    "Content-Type": "text/plain"
  });

  if (req.url === "/health") {
    res.end(
      "Hunter of Villagers multiplayer server is healthy."
    );
  } else {
    res.end(
      "Hunter of Villagers multiplayer server is running."
    );
  }
});


// --------------------------------------------------
// WEBSOCKET SERVER
// --------------------------------------------------

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

    roomCode: null
  };


  // Tell the player that the connection worked

  send(ws, {
    type: "connected",
    playerId: player.id
  });


  // ------------------------------------------------
  // RECEIVE MESSAGE
  // ------------------------------------------------

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


    // ==============================================
    // CREATE ROOM
    // ==============================================

    if (message.type === "createRoom") {

      const code = makeRoomCode();

      const room = {

        code: code,

        state: "lobby",

        selectedLevel: null,

        players: [
          player
        ]

      };


      player.roomCode = code;

      player.name = String(
        message.name || "Player 1"
      ).slice(0, 20);


      rooms.set(
        code,
        room
      );


      send(ws, {

        type: "roomCreated",

        roomCode: code,

        isHost: true,

        players: getRoomPlayers(room)

      });


      return;
    }


    // ==============================================
    // JOIN ROOM
    // ==============================================

    if (message.type === "joinRoom") {

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

          message:
            "That game has already started."

        });

        return;
      }


      player.roomCode = code;


      player.name = String(

        message.name ||

        "Player " +
        (room.players.length + 1)

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


    // ==============================================
    // FIND PLAYER'S ROOM
    // ==============================================

    const room = player.roomCode
      ? rooms.get(player.roomCode)
      : null;


    if (!room) {

      send(ws, {

        type: "error",

        message:
          "You are not in a room."

      });

      return;
    }


    // ==============================================
    // HOST STARTS GAME
    // ==============================================

    if (message.type === "startGame") {

      // Only first player is host

      if (room.players[0] !== player) {

        send(ws, {

          type: "error",

          message:
            "Only the host can start the game."

        });

        return;
      }


      // Require at least two players

      if (room.players.length < 2) {

        send(ws, {

          type: "error",

          message:
            "Waiting for another player."

        });

        return;
      }


      room.state =
        "selectingLevel";


      // Tell everybody that the host
      // is now choosing a level

      broadcast(room, {

        type: "hostStarted",

        hostId: player.id

      });


      return;
    }


    // ==============================================
    // HOST SELECTS LEVEL
    // ==============================================

    if (message.type === "selectLevel") {

      // Only host can select

      if (room.players[0] !== player) {

        send(ws, {

          type: "error",

          message:
            "Only the host can select the level."

        });

        return;
      }


      // IMPORTANT:
      // Do NOT use || here.
      //
      // Level 0 is a valid level.
      //
      // This fixes the bug where Level 1
      // could not be selected.

      if (
        message.level === undefined ||
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


      // Tell everyone to start

      broadcast(room, {

        type: "gameStarted",

        level:
          room.selectedLevel

      });


      return;
    }


    // ==============================================
    // PLAYER UPDATE
    // ==============================================

    if (message.type === "playerUpdate") {

      for (
        const other of room.players
      ) {

        if (other !== player) {

          send(other.ws, {

            type: "playerUpdate",

            playerId:
              player.id,

            data:
              message.data || {}

          });

        }

      }


      return;
    }

  });


  // ------------------------------------------------
  // PLAYER DISCONNECTS
  // ------------------------------------------------

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
        other =>
          other !== player
      );


    // Delete empty room

    if (
      room.players.length === 0
    ) {

      rooms.delete(
        room.code
      );

      return;
    }


    // Tell remaining players

    broadcast(room, {

      type: "lobbyUpdate",

      players:
        getRoomPlayers(room)

    });

  });

});


// --------------------------------------------------
// START SERVER
// --------------------------------------------------

httpServer.listen(
  PORT,
  () => {

    console.log(
      "Hunter of Villagers multiplayer server running on port " +
      PORT
    );

  }
);
