// Quoridor Multiplayer Cloudflare Worker
// WebSocket: wss://quoridor.boazdro.workers.dev/ws

export class QuoridorRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> { roomCode, playerNum, name }
    this.rooms = new Map();

    // Global fallback room for clients that connect without creating/joining a room.
    this.rooms.set("GLOBAL", this.newRoom("GLOBAL", "משחק", 2));
  }

  newRoom(code, name, maxPlayers = 2) {
    return {
      code,
      name,
      maxPlayers,
      type: "room",
      started: false,
      createdAt: Date.now(),
      players: [],
      gameState: this.newGameState()
    };
  }

  newGameState() {
    return {
      boardSize: 9,
      players: {
        1: { r: 8, c: 4, walls: 10 },
        2: { r: 0, c: 4, walls: 10 }
      },
      walls: [],
      turn: 1,
      winner: null
    };
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Quoridor WebSocket server is running", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    await this.handleSession(server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async handleSession(ws) {
    ws.accept();

    this.sessions.set(ws, {
      roomCode: "GLOBAL",
      playerNum: null,
      name: "צופה"
    });

    ws.send(JSON.stringify({
      type: "connected",
      server: "quoridor.boazdro.workers.dev"
    }));

    ws.addEventListener("message", async event => {
      try {
        const data = JSON.parse(event.data);
        await this.handleMessage(ws, data);
      } catch (err) {
        this.send(ws, {
          type: "error",
          message: "בקשה לא תקינה"
        });
        console.error(err);
      }
    });

    ws.addEventListener("close", () => {
      const session = this.sessions.get(ws);
      if (session) {
        const room = this.rooms.get(session.roomCode);
        if (room) {
          room.players = room.players.filter(
            p => p.playerNum !== session.playerNum || p.ws !== ws
          );
          this.broadcastRoom(session.roomCode, {
            type: "room_update",
            roomCode: session.roomCode,
            players: this.publicPlayers(room),
            playerCount: room.players.length
          });
        }
      }
      this.sessions.delete(ws);
    });
  }

  async handleMessage(ws, data) {
    switch (data.type) {
      case "room_create":
        return this.createRoom(ws, data);

      case "room_join":
        return this.joinRoom(ws, data);

      case "tournament_create":
        return this.createTournament(ws, data);

      case "game_start":
        return this.startGame(ws, data);

      case "move":
        return this.handleMove(ws, data);

      case "wall":
        return this.handleWall(ws, data);

      case "ping":
        this.send(ws, { type: "pong" });
        return;

      default:
        this.send(ws, {
          type: "error",
          message: "סוג הודעה לא מוכר: " + String(data.type || "")
        });
    }
  }

  createRoom(ws, data) {
    const name = this.cleanName(data.name);
    const code = this.makeCode();

    const room = this.newRoom(code, name + " - חדר", 2);
    room.type = "room";
    this.rooms.set(code, room);

    this.addPlayer(ws, room, name, 1);

    this.send(ws, {
      type: "room_created",
      roomCode: code,
      playerNum: 1,
      room: {
        code,
        name: room.name,
        maxPlayers: 2,
        players: this.publicPlayers(room)
      }
    });

    this.sendRoomState(code);
  }

  joinRoom(ws, data) {
    const code = String(data.roomCode || data.code || "").trim().toUpperCase();

    if (!code) {
      this.send(ws, { type: "error", message: "לא הוזן קוד חדר" });
      return;
    }

    const room = this.rooms.get(code);

    if (!room) {
      this.send(ws, {
        type: "error",
        message: "החדר לא נמצא"
      });
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      this.send(ws, {
        type: "error",
        message: "החדר מלא"
      });
      return;
    }

    const playerNum = this.nextPlayerNumber(room);
    if (playerNum == null) {
      this.send(ws, {
        type: "error",
        message: "אין מקום לשחקן נוסף בחדר"
      });
      return;
    }

    this.addPlayer(ws, room, this.cleanName(data.name), playerNum);

    this.send(ws, {
      type: "room_joined",
      roomCode: code,
      playerNum,
      room: {
        code,
        name: room.name,
        maxPlayers: room.maxPlayers,
        players: this.publicPlayers(room)
      }
    });

    this.sendRoomState(code);

    if (room.players.length >= 2 && room.maxPlayers === 2) {
      room.started = true;
      this.broadcastRoom(code, {
        type: "game_start",
        roomCode: code,
        gameState: room.gameState
      });
    }
  }

  createTournament(ws, data) {
    const name = this.cleanName(data.name);
    const count = Math.max(
      2,
      Math.min(64, Number(data.playerCount) || 8)
    );

    const code = "T" + this.makeCode(5);
    const room = this.newRoom(code, name + " - תחרות", count);
    room.type = "tournament";
    room.tournament = {
      playerCount: count,
      rounds: [],
      status: "waiting"
    };

    this.rooms.set(code, room);
    this.addPlayer(ws, room, name, 1);

    this.send(ws, {
      type: "tournament_created",
      roomCode: code,
      playerNum: 1,
      tournament: {
        code,
        playerCount: count,
        players: this.publicPlayers(room)
      }
    });

    this.sendRoomState(code);
  }

  startGame(ws, data) {
    const session = this.sessions.get(ws);
    if (!session) return;

    const code = String(data.roomCode || session.roomCode).toUpperCase();
    const room = this.rooms.get(code);

    if (!room) {
      this.send(ws, { type: "error", message: "החדר לא נמצא" });
      return;
    }

    room.started = true;

    if (room.type === "tournament" && room.tournament) {
      room.tournament.status = "started";
    }

    this.broadcastRoom(code, {
      type: "game_start",
      roomCode: code,
      gameState: room.gameState
    });
  }

  handleMove(ws, data) {
    const session = this.sessions.get(ws);
    if (!session || !session.playerNum) return;

    const room = this.rooms.get(session.roomCode);
    if (!room) return;

    const n = Number(data.playerNum);
    const r = Number(data.r);
    const c = Number(data.c);

    if (n !== session.playerNum) return;

    if (room.gameState.winner) return;

    if (room.gameState.turn !== n) {
      this.send(ws, { type: "error", message: "זה לא התור שלך" });
      return;
    }

    if (!room.gameState.players[n]) return;

    const me = room.gameState.players[n];

    if (!this.validCell(r, c) ||
        Math.abs(me.r - r) + Math.abs(me.c - c) !== 1) {
      this.send(ws, { type: "error", message: "מהלך לא חוקי" });
      return;
    }

    if (this.isOccupied(room.gameState, r, c)) {
      this.send(ws, { type: "error", message: "המשבצת תפוסה" });
      return;
    }

    if (this.hasWallBetween(room.gameState, me.r, me.c, r, c)) {
      this.send(ws, { type: "error", message: "יש קיר בדרך" });
      return;
    }

    me.r = r;
    me.c = c;

    if (n === 1 && r === 0) room.gameState.winner = 1;
    if (n === 2 && r === 8) room.gameState.winner = 2;

    if (!room.gameState.winner) {
      room.gameState.turn = n === 1 ? 2 : 1;
    }

    this.broadcastRoom(session.roomCode, {
      type: "update",
      gameState: room.gameState
    });
  }

  handleWall(ws, data) {
    const session = this.sessions.get(ws);
    if (!session || !session.playerNum) return;

    const room = this.rooms.get(session.roomCode);
    if (!room) return;

    const n = Number(data.playerNum);
    const r = Number(data.r);
    const c = Number(data.c);
    const wallType = String(data.wallType || data.type || "").toLowerCase();

    if (n !== session.playerNum) return;

    if (room.gameState.winner) return;

    if (room.gameState.turn !== n) {
      this.send(ws, { type: "error", message: "זה לא התור שלך" });
      return;
    }

    if (wallType !== "h" && wallType !== "v") {
      this.send(ws, { type: "error", message: "סוג קיר לא תקין" });
      return;
    }

    const player = room.gameState.players[n];

    if (!player || player.walls <= 0) {
      this.send(ws, { type: "error", message: "אין לך יותר קירות" });
      return;
    }

    if (r < 0 || r > 7 || c < 0 || c > 7) {
      this.send(ws, { type: "error", message: "מיקום קיר לא תקין" });
      return;
    }

    const exists = room.gameState.walls.some(
      w => w.r === r && w.c === c && w.type === wallType
    );

    if (exists) {
      this.send(ws, { type: "error", message: "כבר יש קיר במקום הזה" });
      return;
    }

    room.gameState.walls.push({
      r,
      c,
      type: wallType
    });

    player.walls--;
    room.gameState.turn = n === 1 ? 2 : 1;

    this.broadcastRoom(session.roomCode, {
      type: "update",
      gameState: room.gameState
    });
  }

  addPlayer(ws, room, name, playerNum) {
    const old = this.sessions.get(ws);

    if (old && old.roomCode !== room.code) {
      const oldRoom = this.rooms.get(old.roomCode);
      if (oldRoom) {
        oldRoom.players = oldRoom.players.filter(p => p.ws !== ws);
      }
    }

    const session = {
      roomCode: room.code,
      playerNum,
      name
    };

    this.sessions.set(ws, session);

    room.players = room.players.filter(p => p.ws !== ws);
    room.players.push({
      ws,
      playerNum,
      name
    });
  }

  nextPlayerNumber(room) {
    for (let i = 1; i <= room.maxPlayers; i++) {
      if (!room.players.some(p => p.playerNum === i)) return i;
    }
    return null;
  }

  publicPlayers(room) {
    return room.players.map(p => ({
      playerNum: p.playerNum,
      name: p.name
    }));
  }

  sendRoomState(code) {
    const room = this.rooms.get(code);
    if (!room) return;

    this.broadcastRoom(code, {
      type: room.type === "tournament" ? "tournament_update" : "room_update",
      roomCode: code,
      players: this.publicPlayers(room),
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      gameState: room.gameState
    });
  }

  broadcastRoom(code, message) {
    const payload = JSON.stringify(message);

    for (const [ws, session] of this.sessions) {
      if (session.roomCode !== code) continue;

      try {
        ws.send(payload);
      } catch (e) {}
    }
  }

  send(ws, message) {
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {}
  }

  cleanName(value) {
    const s = String(value || "שחקן").trim().slice(0, 24);
    return s || "שחקן";
  }

  makeCode(length = 6) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";

    do {
      code = "";
      for (let i = 0; i < length; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
    } while (this.rooms.has(code));

    return code;
  }

  validCell(r, c) {
    return Number.isInteger(r) &&
           Number.isInteger(c) &&
           r >= 0 && r < 9 &&
           c >= 0 && c < 9;
  }

  isOccupied(state, r, c) {
    return Object.values(state.players).some(
      p => p.r === r && p.c === c
    );
  }

  hasWallBetween(state, r1, c1, r2, c2) {
    for (const w of state.walls) {
      if (w.type === "h") {
        if (r2 === r1 - 1 && w.r === r2 &&
            (w.c === c1 || w.c === c1 - 1)) return true;

        if (r2 === r1 + 1 && w.r === r1 &&
            (w.c === c1 || w.c === c1 - 1)) return true;
      }

      if (w.type === "v") {
        if (c2 === c1 - 1 && w.c === c2 &&
            (w.r === r1 || w.r === r1 - 1)) return true;

        if (c2 === c1 + 1 && w.c === c1 &&
            (w.r === r1 || w.r === r1 - 1)) return true;
      }
    }

    return false;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        "Quoridor server is online. WebSocket endpoint: /ws",
        {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8"
          }
        }
      );
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const id = env.ROOM.idFromName("global_room");
      const roomObject = env.ROOM.get(id);
      return roomObject.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};
