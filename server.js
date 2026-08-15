const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS_PER_ROOM = 4;

const rooms = new Map();


// ==================================================
// ROOM CODE
// ==================================================

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


// ==================================================
// SEND
// ==================================================

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}


// ==================================================
// BROADCAST TO EVERY PLAYER
// ==================================================

function broadcast(room, message) {
  for (const player of room.players) {
    send(player.ws, message);
  }
}


// ==================================================
// BROADCAST TO EVERYONE EXCEPT ONE PLAYER
// ==================================================

function broadcastExcept(room, exceptPlayer, message) {
  for (const player of room.players) {
    if (player !== exceptPlayer) {
      send(player.ws, message);
    }
  }
}


// ==================================================
// PLAYER LIST
// ==================================================

function getRoomPlayers(room) {

  return room.players.map((player, index) => {

    return {
      id: player.id,

      name: player.name,

      host: index === 0,

      x: player.x,

      y: player.y,

      z: player.z,

      yaw: player.yaw
    };

  });

}


// ==================================================
// HTTP SERVER
// ==================================================

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


// ==================================================
// WEBSOCKET SERVER
// ==================================================

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

    yaw: 0

  };


  // Tell the client that the connection worked

  send(ws, {

    type: "connected",

    playerId: player.id

  });


  // ==================================================
  // RECEIVE MESSAGE
  // ==================================================

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


    // ==================================================
    // CREATE ROOM
    // ==================================================

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


    // ==================================================
    // JOIN ROOM
    // ==================================================

    if (message.type === "joinRoom") {

      const code = String(

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


      // Don't allow players to join after
      // the host has started the game.

      if (room.state !== "lobby") {

        send(ws, {

          type: "error",

          message:
            "That game has already started."

        });

        return;

      }


      // Maximum 4 players

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


      player.name = String(

        message.name ||

        `Player ${room.players.length + 1}`

      ).slice(0, 20);


      room.players.push(

        player

      );


      // Tell EVERYONE about the new player

      broadcast(room, {

        type: "lobbyUpdate",

        players:
          getRoomPlayers(room)

      });


      return;

    }


    // ==================================================
    // FIND ROOM
    // ==================================================

    const room = player.roomCode

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


    // ==================================================
    // HOST STARTS GAME
    // ==================================================

    if (message.type === "startGame") {

      // First player is always host

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


      // Need at least 2 players

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


      // Tell EVERY player that
      // the host can select the level

      broadcast(room, {

        type: "hostStarted",

        hostId:
          player.id

      });


      return;

    }


    // ==================================================
    // HOST SELECTS LEVEL
    // ==================================================

    if (
      message.type === "selectLevel"
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


      // IMPORTANT:
      // Level 0 is a valid level.

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


      // Tell EVERY player to start

      broadcast(room, {

        type: "gameStarted",

        level:
          room.selectedLevel

      });


      return;

    }


    // ==================================================
    // PLAYER UPDATE
    // ==================================================

    if (
      message.type === "playerUpdate"
    ) {

      const data =
        message.data || {};


      // Store latest player position

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


      // Send this player's update
      // to EVERY OTHER PLAYER.

      broadcastExcept(

        room,

        player,

        {

          type:
            "playerUpdate",

          playerId:
            player.id,

          data:
            data

        }

      );


      return;

    }

  });


  // ==================================================
  // PLAYER DISCONNECT
  // ==================================================

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


    // Delete empty rooms

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

      type:
        "lobbyUpdate",

      players:
        getRoomPlayers(room)

    });

  });

});


// ==================================================
// START SERVER
// ==================================================

httpServer.listen(

  PORT,

  () => {

    console.log(

      "Hunter of Villagers multiplayer server running on port " +

      PORT +

      " | Maximum players per room: " +

      MAX_PLAYERS_PER_ROOM

    );

  }

);
