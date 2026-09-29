// src/index.js
export class QuoridorRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = [];
    this.gameState = {
      boardSize: 9,
      players: {
        1: { r: 8, c: 4, walls: 10 },
        2: { r: 0, c: 4, walls: 10 }
      },
      walls: [], // { r, c, type: 'v'|'h' }
      turn: 1,
      winner: null
    };
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    await this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleSession(ws) {
    ws.accept();
    this.sessions.push(ws);
    
    // Assign player number based on connection order
    const playerNum = this.sessions.length <= 2 ? this.sessions.length : null;
    ws.send(JSON.stringify({ type: "init", playerNum, gameState: this.gameState }));

    ws.addEventListener("message", async (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === "move" && this.gameState.turn === data.playerNum && !this.gameState.winner) {
          // Update piece position
          this.gameState.players[data.playerNum].r = data.r;
          this.gameState.players[data.playerNum].c = data.c;
          
          // Check for win condition
          if (data.playerNum === 1 && data.r === 0) this.gameState.winner = 1;
          if (data.playerNum === 2 && data.r === 8) this.gameState.winner = 2;
          
          this.gameState.turn = this.gameState.turn === 1 ? 2 : 1;
          this.broadcast({ type: "update", gameState: this.gameState });
        } else if (data.type === "wall" && this.gameState.turn === data.playerNum && !this.gameState.winner) {
          if (this.gameState.players[data.playerNum].walls > 0) {
            this.gameState.walls.push({ r: data.r, c: data.c, type: data.wallType });
            this.gameState.players[data.playerNum].walls--;
            this.gameState.turn = this.gameState.turn === 1 ? 2 : 1;
            this.broadcast({ type: "update", gameState: this.gameState });
          }
        }
      } catch (e) {
        console.error(e);
      }
    });

    ws.addEventListener("close", () => {
      this.sessions = this.sessions.filter(s => s !== ws);
    });
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const session of this.sessions) {
      try { session.send(payload); } catch (e) {}
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Serve the HTML Frontend game board
    if (url.pathname === "/") {
      return new Response(getHTML(), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // Connect to WebSocket room
    if (url.pathname === "/ws") {
      const id = env.ROOM.idFromName("global_room");
      const roomObject = env.ROOM.get(id);
      return roomObject.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

function getHTML() {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>קורידור אונליין</title>
    <style>
      body { font-family: sans-serif; text-align: center; background: #2c3e50; color: white; direction: rtl; }
      #game-container { display: flex; flex-direction: column; align-items: center; margin-top: 20px; }
      #board { display: grid; grid-template-columns: repeat(9, 50px); grid-template-rows: repeat(9, 50px); gap: 10px; background: #34495e; padding: 10px; border-radius: 8px; position: relative; }
      .cell { background: #e0e0e0; border-radius: 4px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 0.2s; }
      .cell:hover { background: #bdc3c7; }
      .player { width: 35px; height: 35px; border-radius: 50%; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
      .p1 { background: #e74c3c; }
      .p2 { background: #3498db; }
      #status { margin: 15px; font-size: 1.2rem; font-weight: bold; }
    </style>
  </head>
  <body>
    <h1>♟️ משחק קורידור מרובה משתתפים ♟️</h1>
    <div id="status">מתחבר לשרת...</div>
    <div id="game-container">
      <div id="board"></div>
    </div>

    <script>
      let ws = new WebSocket((window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws');
      let myPlayerNum = null;
      let state = null;

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'init') {
          myPlayerNum = msg.playerNum;
          state = msg.gameState;
          document.getElementById('status').innerText = myPlayerNum ? 'אתה שחקן ' + myPlayerNum : 'אתה צופה במשחק';
          renderBoard();
        } else if (msg.type === 'update') {
          state = msg.gameState;
          renderBoard();
        }
      };

      function renderBoard() {
        const board = document.getElementById('board');
        board.innerHTML = '';
        
        let turnText = state.winner ? '🏆 שחקן ' + state.winner + ' ניצח!' : 'תור שחקן: ' + state.turn;
        document.getElementById('status').innerText = (myPlayerNum ? 'אתה שחקן ' + myPlayerNum + ' | ' : '') + turnText;

        for (let r = 0; r < 9; r++) {
          for (let c = 0; c < 9; c++) {
            const cell = document.createElement('div');
            cell.className = 'cell';
            cell.dataset.r = r;
            cell.dataset.c = c;

            if (state.players[1].r === r && state.players[1].c === c) {
              const p = document.createElement('div'); p.className = 'player p1'; cell.appendChild(p);
            } else if (state.players[2].r === r && state.players[2].c === c) {
              const p = document.createElement('div'); p.className = 'player p2'; cell.appendChild(p);
            }

            cell.onclick = () => {
              if (state.turn !== myPlayerNum || state.winner) return;
              // Simple valid move check (1 step away)
              let myPos = state.players[myPlayerNum];
              let dist = Math.abs(myPos.r - r) + Math.abs(myPos.c - c);
              if (dist === 1) {
                ws.send(JSON.stringify({ type: 'move', playerNum: myPlayerNum, r, c }));
              }
            };
            board.appendChild(cell);
          }
        }
      }
    </script>
  </body>
  </html>
  `;
}
