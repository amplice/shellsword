const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ============================================================
// DATABASE INITIALIZATION
// ============================================================
const db = Database(path.join(__dirname, 'shellsword.db'));

// Initialize database tables
db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    p1_name TEXT NOT NULL,
    p2_name TEXT NOT NULL,
    state_json TEXT NOT NULL,
    turn INTEGER NOT NULL,
    phase TEXT NOT NULL,
    winner TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS queue_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token TEXT NOT NULL,
    ip TEXT,
    created_at INTEGER NOT NULL
  );
  
  CREATE INDEX IF NOT EXISTS idx_games_phase ON games(phase);
  CREATE INDEX IF NOT EXISTS idx_queue_created ON queue_entries(created_at);
`);

// Prepared statements for better performance
const insertGameStmt = db.prepare(`
  INSERT OR REPLACE INTO games (id, p1_name, p2_name, state_json, turn, phase, winner, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateGameStmt = db.prepare(`
  UPDATE games SET state_json = ?, turn = ?, phase = ?, winner = ?, updated_at = ?
  WHERE id = ?
`);

const insertQueueStmt = db.prepare(`
  INSERT INTO queue_entries (name, token, ip, created_at)
  VALUES (?, ?, ?, ?)
`);

const deleteQueueStmt = db.prepare(`
  DELETE FROM queue_entries WHERE token = ?
`);

const loadActiveGamesStmt = db.prepare(`
  SELECT * FROM games WHERE phase != 'over' ORDER BY created_at
`);

const loadQueueStmt = db.prepare(`
  SELECT * FROM queue_entries ORDER BY created_at
`);

const getCompletedGamesStmt = db.prepare(`
  SELECT * FROM games WHERE phase = 'over' ORDER BY updated_at DESC LIMIT 100
`);

// ============================================================
// DATABASE HELPERS
// ============================================================
function saveGameToDB(game) {
  const now = Date.now();
  
  const stateJson = JSON.stringify({
    distance: game.distance,
    scores: game.scores,
    moves: game.moves,
    lastResult: game.lastResult,
    maxTurns: game.maxTurns,
    botDifficulty: game.botDifficulty,
    botSide: game.botSide,
    exhibition: game.exhibition,
    botP1Difficulty: game.botP1Difficulty,
    botP2Difficulty: game.botP2Difficulty,
    p1Token: game.p1Token,
    p2Token: game.p2Token,
    p1: game.p1,
    p2: game.p2
  });
  
  try {
    const result = updateGameStmt.run(stateJson, game.turn, game.phase, game.winner, now, game.id);
    if (result.changes === 0) {
      // No rows updated, need to insert
      insertGameStmt.run(
        game.id, 
        game.p1Name || 'P1', 
        game.p2Name || 'P2', 
        stateJson, 
        game.turn, 
        game.phase, 
        game.winner, 
        now, 
        now
      );
    }
  } catch (err) {
    console.error(`[DB] Error saving game ${game.id}:`, err.message);
  }
}

function loadGameFromDB(row) {
  const game = createGame(row.id);
  const state = JSON.parse(row.state_json);
  
  // Restore game state
  game.p1Name = row.p1_name;
  game.p2Name = row.p2_name;
  game.turn = row.turn;
  game.phase = row.phase;
  game.winner = row.winner;
  game.distance = state.distance;
  game.scores = state.scores;
  game.moves = state.moves;
  game.lastResult = state.lastResult;
  game.maxTurns = state.maxTurns || 30;
  game.botDifficulty = state.botDifficulty;
  game.botSide = state.botSide;
  game.exhibition = state.exhibition;
  game.botP1Difficulty = state.botP1Difficulty;
  game.botP2Difficulty = state.botP2Difficulty;
  game.p1Token = state.p1Token;
  game.p2Token = state.p2Token;
  game.p1 = state.p1;
  game.p2 = state.p2;
  
  // Initialize runtime state
  game.moveWaiters = [];
  game.turnTimer = null;
  
  return game;
}

function saveQueueToDB(entry) {
  insertQueueStmt.run(entry.name, entry.token, entry.ip || null, entry.timestamp);
}

function removeFromQueueDB(token) {
  deleteQueueStmt.run(token);
}

// ============================================================
// QUEUE WEBHOOK — wake OpenClaw when someone joins
// ============================================================
const fs = require('fs');
const QUEUE_FLAG = path.join(__dirname, '.queue-waiting');

function notifyQueueJoin(name) {
  // Auto-player handles all matches — only alert for genuinely NEW players
  if (name === 'Nox' || name === 'Nox_CTF') {
    console.log(`[QUEUE] Auto-player "${name}" joined — no alert needed`);
    return;
  }
  
  // Known repeat queuers (auto-bots) — don't alert, auto-player handles them
  const KNOWN_BOTS = ['kavklaww'];
  if (KNOWN_BOTS.includes(name)) {
    console.log(`[QUEUE] Known bot "${name}" joined — auto-player handles, no alert`);
    return;
  }
  
  // Don't spam alerts — only fire once per 30 minutes per name
  try {
    const flag = fs.existsSync(QUEUE_FLAG) ? JSON.parse(fs.readFileSync(QUEUE_FLAG, 'utf8')) : null;
    if (flag && flag.name === name && Date.now() - new Date(flag.timestamp).getTime() < 1800000) {
      console.log(`[QUEUE] Suppressing repeat alert for "${name}" (last alert <30min ago)`);
      return;
    }
  } catch(e) { /* ignore parse errors */ }
  
  fs.writeFileSync(QUEUE_FLAG, JSON.stringify({ name, timestamp: new Date().toISOString() }));
  
  const postData = JSON.stringify({ 
    text: `SHELLSWORD ALERT: "${name}" joined queue and is waiting for an opponent. Spawn a Sonnet sub-agent NOW to play them: POST /api/join to localhost:3001, then play the full game. Delete .queue-waiting after.`, 
    mode: 'now' 
  });
  
  const req = http.request({
    hostname: '127.0.0.1',
    port: 18789,
    path: '/hooks/wake',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Authorization': 'Bearer 377b9799e11a9dfa71e24b10f680b270332d9eeb39da9e36',
    },
    timeout: 3000,
  }, (res) => {
    console.log(`[WEBHOOK] Wake sent for "${name}", status=${res.statusCode}`);
  });
  
  req.on('error', (e) => console.log(`[WEBHOOK] Wake failed: ${e.message}`));
  req.write(postData);
  req.end();
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ============================================================
// RATE LIMITING (in-memory, per IP)
// ============================================================
const rateLimitStore = new Map();

function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const endpoint = req.route ? req.route.path : req.path;
    const key = `${ip}:${endpoint}`;
    const now = Date.now();

    if (!rateLimitStore.has(key)) {
      rateLimitStore.set(key, { count: 1, resetTime: now + windowMs });
      return next();
    }

    const entry = rateLimitStore.get(key);
    if (now > entry.resetTime) {
      entry.count = 1;
      entry.resetTime = now + windowMs;
      return next();
    }

    entry.count++;
    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many requests. Slow down.',
        retryAfter,
      });
    }

    next();
  };
}

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetTime) rateLimitStore.delete(key);
  }
}, 5 * 60 * 1000);

const joinLimiter = rateLimit(60, 60_000);      // 60 per minute
const moveLimiter = rateLimit(120, 60_000);     // 120 per minute

// ============================================================
// GAME STATE
// ============================================================
const games = new Map();       // gameId -> game
const players = new Map();     // token -> { gameId, playerId, name }
const queue = [];              // [{ token, name, timestamp }]
const wsClients = new Map();   // ws -> { gameId, playerId, type }
const completedGames = [];     // finished game summaries

let gameIdCounter = 1;
const TURN_TIMEOUT_MS = 300_000; // 5 minutes per turn
const QUEUE_TIMEOUT_MS = 300_000; // 5 minutes queue timeout

// ============================================================
// STARTUP DATA LOADING
// ============================================================
function loadDataFromDB() {
  console.log('[DB] Loading data from database...');
  
  // Load active games
  const activeGames = loadActiveGamesStmt.all();
  for (const row of activeGames) {
    const game = loadGameFromDB(row);
    games.set(game.id, game);
    
    // Restore player mappings
    if (game.p1Token) {
      players.set(game.p1Token, { gameId: game.id, playerId: 'p1', name: game.p1Name });
    }
    if (game.p2Token) {
      players.set(game.p2Token, { gameId: game.id, playerId: 'p2', name: game.p2Name });
    }
    if (game.p1 && game.exhibition) {
      players.set(game.p1, { gameId: game.id, playerId: 'p1' });
    }
    if (game.p2 && game.exhibition) {
      players.set(game.p2, { gameId: game.id, playerId: 'p2' });
    }
    
    // Restart turn timer if game is in input phase
    if (game.phase === 'input') {
      startTurnTimer(game.id);
    }
    
    console.log(`[DB] Loaded game ${game.id} (${game.p1Name} vs ${game.p2Name}), phase=${game.phase}, turn=${game.turn}`);
  }
  
  // Load queue entries (recent ones only)
  const queueEntries = loadQueueStmt.all();
  const now = Date.now();
  for (const row of queueEntries) {
    if (now - row.created_at < QUEUE_TIMEOUT_MS) {
      queue.push({
        token: row.token,
        name: row.name,
        ip: row.ip,
        timestamp: row.created_at
      });
      console.log(`[DB] Restored queue entry: ${row.name}`);
    } else {
      // Remove expired entries
      deleteQueueStmt.run(row.token);
    }
  }
  
  // Load completed games for the recent history
  const completed = getCompletedGamesStmt.all();
  for (const row of completed) {
    const state = JSON.parse(row.state_json);
    completedGames.push({
      id: row.id,
      winner: row.winner,
      turns: row.turn,
      p1Name: row.p1_name,
      p2Name: row.p2_name,
      finalScore: `${state.scores.p1}-${state.scores.p2}`,
      timestamp: row.updated_at,
    });
  }
  
  // Update gameIdCounter to avoid conflicts
  const maxGameId = Math.max(
    ...Array.from(games.keys()).map(id => {
      const match = id.match(/^g(\d+)$/);
      return match ? parseInt(match[1]) : 0;
    }),
    ...completed.map(row => {
      const match = row.id.match(/^g(\d+)$/);
      return match ? parseInt(match[1]) : 0;
    }),
    0
  );
  gameIdCounter = maxGameId + 1;
  
  console.log(`[DB] Loaded ${games.size} active games, ${queue.length} queue entries, ${completedGames.length} completed games. Next game ID: g${gameIdCounter}`);
}

// Load data on startup
loadDataFromDB();

// ============================================================
// GAME LOGIC
// ============================================================
function createGame(id) {
  return {
    id,
    phase: 'input', // input, over
    turn: 0,
    distance: 4, // starting distance
    scores: { p1: 0, p2: 0 },
    moves: { p1: null, p2: null },
    lastResult: '',
    winner: null,
    p1Name: '',
    p2Name: '',
    turnTimer: null,
    moveWaiters: [],
    maxTurns: 30
  };
}

function validateMove(move) {
  const validMoves = ['advance', 'retreat', 'lunge', 'parry'];
  return validMoves.includes(move);
}

function resolveTurn(game) {
  const { moves, distance } = game;
  const p1Move = moves.p1;
  const p2Move = moves.p2;
  
  let newDistance = distance;
  let result = '';
  let scoreP1 = false;
  let scoreP2 = false;
  
  // Priority order: Both lunge → One lunge + one parry → One lunge + other → Movement
  
  // 1. Both lunge at distance 1 → double hit
  if (p1Move === 'lunge' && p2Move === 'lunge' && distance === 1) {
    result = 'Both fencers lunge simultaneously at close range → DOUBLE HIT!';
    scoreP1 = true;
    scoreP2 = true;
  }
  // 2. One lunge + one parry → check riposte
  else if ((p1Move === 'lunge' && p2Move === 'parry') || (p1Move === 'parry' && p2Move === 'lunge')) {
    if (p1Move === 'lunge' && p2Move === 'parry') {
      result = 'P1 lunges → P2 PARRIES → RIPOSTE! P2 scores.';
      scoreP2 = true;
    } else {
      result = 'P2 lunges → P1 PARRIES → RIPOSTE! P1 scores.';
      scoreP1 = true;
    }
  }
  // 3. One lunge + other move → check distance for hit
  else if (p1Move === 'lunge' || p2Move === 'lunge') {
    const lunger = p1Move === 'lunge' ? 'P1' : 'P2';
    const other = p1Move === 'lunge' ? p2Move : p1Move;
    const otherPlayer = p1Move === 'lunge' ? 'P2' : 'P1';
    
    if (distance === 1) {
      result = `${lunger} lunges at close range → HIT! ${lunger} scores.`;
      if (p1Move === 'lunge') scoreP1 = true;
      else scoreP2 = true;
    } else if (distance === 2) {
      // 50% chance for close hit
      const hit = Math.random() < 0.5;
      if (hit) {
        result = `${lunger} lunges at medium range → CLOSE HIT! ${lunger} scores.`;
        if (p1Move === 'lunge') scoreP1 = true;
        else scoreP2 = true;
      } else {
        result = `${lunger} lunges at medium range → miss! ${otherPlayer} ${other}.`;
        // Apply other player's movement if any
        if (other === 'advance') newDistance = Math.max(1, newDistance - 1);
        else if (other === 'retreat') newDistance = Math.min(6, newDistance + 1);
      }
    } else {
      // Distance 3+: whiff and exposed
      result = `${lunger} lunges at long range → WHIFF! ${lunger} is exposed. ${otherPlayer} gets free advance.`;
      newDistance = Math.max(1, newDistance - 1);
      // Apply other player's movement too
      if (other === 'advance') newDistance = Math.max(1, newDistance - 1);
      else if (other === 'retreat') newDistance = Math.min(6, newDistance + 1);
    }
  }
  // 4. Parry without lunge = wasted turn
  else if ((p1Move === 'parry' && p2Move !== 'lunge') || (p2Move === 'parry' && p1Move !== 'lunge')) {
    const parryer = p1Move === 'parry' ? 'P1' : 'P2';
    const other = p1Move === 'parry' ? p2Move : p1Move;
    const otherPlayer = p1Move === 'parry' ? 'P2' : 'P1';
    
    result = `${parryer} parries nothing (wasted turn). ${otherPlayer} ${other}.`;
    
    // Apply other player's movement
    if (other === 'advance') newDistance = Math.max(1, newDistance - 1);
    else if (other === 'retreat') newDistance = Math.min(6, newDistance + 1);
  }
  // 5. Movement only
  else {
    let movements = [];
    if (p1Move === 'advance') movements.push('P1 advances');
    if (p2Move === 'advance') movements.push('P2 advances'); 
    if (p1Move === 'retreat') movements.push('P1 retreats');
    if (p2Move === 'retreat') movements.push('P2 retreats');
    
    result = movements.length ? movements.join(', ') + '.' : 'Both fencers stay in position.';
    
    // Calculate distance change
    let distanceChange = 0;
    if (p1Move === 'advance') distanceChange--;
    if (p1Move === 'retreat') distanceChange++;
    if (p2Move === 'advance') distanceChange--;
    if (p2Move === 'retreat') distanceChange++;
    
    newDistance = Math.max(1, Math.min(6, distance + distanceChange));
    
    // Special case: both advance to distance 1 = clash
    if (p1Move === 'advance' && p2Move === 'advance' && newDistance <= 1) {
      newDistance = 1;
      result = 'Both fencers advance → CLASH! Distance stays at 1.';
    }
  }
  
  // Update scores
  if (scoreP1) game.scores.p1++;
  if (scoreP2) game.scores.p2++;
  
  // Reset distance if someone scored (except double hit)
  if ((scoreP1 || scoreP2) && !(scoreP1 && scoreP2)) {
    newDistance = 4;
    result += ` Distance resets to 4.`;
  }
  
  // Update game state
  game.distance = newDistance;
  game.turn++;
  game.lastResult = result;
  game.moves = { p1: null, p2: null };
  
  // Check win conditions
  if (game.scores.p1 >= 3 && game.scores.p2 >= 3) {
    // Both reached 3, sudden death
    game.winner = 'sudden_death';
    game.phase = 'over';
  } else if (game.scores.p1 >= 3) {
    game.winner = 'p1';
    game.phase = 'over';
  } else if (game.scores.p2 >= 3) {
    game.winner = 'p2';
    game.phase = 'over';
  } else if (game.turn >= game.maxTurns) {
    // Tiebreak: most touches, then sudden death
    if (game.scores.p1 > game.scores.p2) {
      game.winner = 'p1';
    } else if (game.scores.p2 > game.scores.p1) {
      game.winner = 'p2'; 
    } else {
      game.winner = 'sudden_death';
    }
    game.phase = 'over';
  }
  
  return result;
}

function getGameState(game, playerId) {
  const score = playerId === 'p1' ? game.scores.p1 : game.scores.p2;
  const oppScore = playerId === 'p1' ? game.scores.p2 : game.scores.p1;
  const validMoves = ['advance', 'retreat', 'lunge', 'parry'];
  
  return {
    turn: game.turn,
    distance: game.distance,
    score,
    oppScore,
    lastResult: game.lastResult,
    validMoves,
    phase: game.phase,
    winner: game.winner,
    maxTurns: game.maxTurns
  };
}

function compactState(game, playerId) {
  const state = getGameState(game, playerId);
  const lines = [
    `SHELLSWORD | Touch ${state.score}-${state.oppScore} | Dist:${state.distance} | Turn ${state.turn}/${state.maxTurns}`,
  ];
  
  if (state.lastResult) {
    lines.push(`last: ${state.lastResult}`);
  }
  
  lines.push(`valid: ${state.validMoves.join('/')}`);
  
  if (state.phase === 'over') {
    let endMsg = '';
    if (state.winner === 'p1' && playerId === 'p1') endMsg = 'You WIN!';
    else if (state.winner === 'p2' && playerId === 'p2') endMsg = 'You WIN!';
    else if (state.winner === 'sudden_death') endMsg = 'SUDDEN DEATH required!';
    else endMsg = 'You lose.';
    lines.push(`GAME OVER: ${endMsg}`);
  }
  
  return lines.join('\n');
}

// ============================================================
// BOT AI
// ============================================================
function botMove(state, difficulty = 'medium') {
  const { distance, score, oppScore, turn } = state;
  const moves = ['advance', 'retreat', 'lunge', 'parry'];
  
  if (difficulty === 'easy') {
    return moves[Math.floor(Math.random() * moves.length)];
  }
  
  if (difficulty === 'medium') {
    // Basic strategy
    if (distance === 1) {
      return Math.random() < 0.7 ? 'lunge' : 'parry';
    } else if (distance === 2) {
      return Math.random() < 0.4 ? 'lunge' : (Math.random() < 0.5 ? 'advance' : 'parry');
    } else {
      return Math.random() < 0.6 ? 'advance' : 'retreat';
    }
  }
  
  if (difficulty === 'hard') {
    // Pattern-aware strategy
    if (distance === 1) {
      // At distance 1, usually lunge unless expecting a lunge (then parry)
      return Math.random() < 0.8 ? 'lunge' : 'parry';
    } else if (distance === 2) {
      // Risk/reward at distance 2
      if (score < oppScore) {
        // Behind, take risks
        return Math.random() < 0.6 ? 'lunge' : 'advance';
      } else {
        // Ahead or tied, be more cautious
        return Math.random() < 0.3 ? 'lunge' : (Math.random() < 0.4 ? 'advance' : 'parry');
      }
    } else {
      // Distance 3+, mostly advance but sometimes retreat to control distance
      return Math.random() < 0.75 ? 'advance' : 'retreat';
    }
  }
  
  return 'advance'; // fallback
}

// ============================================================
// HELPERS
// ============================================================
function genToken() {
  return crypto.randomBytes(16).toString('hex');
}

function wsBroadcast(gameId, msg) {
  for (const [ws, info] of wsClients) {
    if (info.gameId === gameId && ws.readyState === WebSocket.OPEN) {
      if (info.type === 'spectator') {
        const game = games.get(gameId);
        ws.send(JSON.stringify({ ...msg, state: compactState(game, 'spectator') }));
      } else if (info.type === 'player') {
        const game = games.get(gameId);
        ws.send(JSON.stringify({ ...msg, state: compactState(game, info.playerId) }));
      }
    }
  }
}

function resolveIfReady(gameId) {
  const game = games.get(gameId);
  if (!game || game.phase !== 'input') return;
  if (!game.moves.p1 || !game.moves.p2) return;

  // Clear turn timer
  if (game.turnTimer) { clearTimeout(game.turnTimer); game.turnTimer = null; }

  const log = resolveTurn(game);
  if (game.phase !== 'over') {
    game.phase = 'input';
    startTurnTimer(gameId);
  } else {
    archiveGame(game);
  }
  
  // Save updated game state to database
  saveGameToDB(game);

  // Notify waiting long-pollers
  if (game.moveWaiters) {
    for (const waiter of game.moveWaiters) {
      waiter.resolve(log);
    }
    game.moveWaiters = [];
  }

  // Broadcast to WS clients
  wsBroadcast(gameId, { type: 'turn_resolved', log });

  // Bot follow-up
  if (game.botDifficulty && game.phase === 'input') {
    setTimeout(() => {
      const botState = getGameState(game, game.botSide || 'p2');
      game.moves[game.botSide || 'p2'] = botMove(botState, game.botDifficulty);
      resolveIfReady(gameId);
    }, 200);
  }
}

function startTurnTimer(gameId) {
  const game = games.get(gameId);
  if (!game || game.phase !== 'input') return;

  game.turnTimer = setTimeout(() => {
    // Auto-submit 'advance' for anyone who hasn't moved
    if (!game.moves.p1) game.moves.p1 = 'advance';
    if (!game.moves.p2) game.moves.p2 = 'advance';
    resolveIfReady(gameId);
  }, TURN_TIMEOUT_MS);
}

function archiveGame(game) {
  completedGames.push({
    id: game.id,
    winner: game.winner,
    turns: game.turn,
    p1Name: game.p1Name || 'P1',
    p2Name: game.p2Name || 'P2',
    finalScore: `${game.scores.p1}-${game.scores.p2}`,
    timestamp: Date.now(),
  });
  if (completedGames.length > 100) completedGames.shift();
}

function matchPlayers(token1, name1, token2, name2) {
  const id = `g${gameIdCounter++}`;
  const game = createGame(id);
  game.phase = 'input';
  game.p1Token = token1;
  game.p2Token = token2;
  game.p1Name = name1;
  game.p2Name = name2;
  game.moveWaiters = [];
  games.set(id, game);

  players.set(token1, { gameId: id, playerId: 'p1', name: name1 });
  players.set(token2, { gameId: id, playerId: 'p2', name: name2 });

  startTurnTimer(id);
  
  // Save new game to database
  saveGameToDB(game);
  
  return id;
}

// ============================================================
// REST API — LLM AGENT ENDPOINTS
// ============================================================

// GET /api/rules — game rules in plain text
app.get('/api/rules', (req, res) => {
  res.type('text/plain').send(`SHELLSWORD — Rules
===================
1D fencing strip. Players start at distance 4. Simultaneous blind turns.

OBJECTIVE: First to 3 touches wins. Max 30 turns.

MOVES: advance, retreat, lunge, parry (single word only)
- advance: distance -1 (minimum 1)
- retreat: distance +1 (maximum 6) 
- lunge: attack move, effect depends on distance
- parry: defensive move against lunges

LUNGE MECHANICS:
- Distance 1: HIT (you score)
- Distance 2: CLOSE HIT (50% chance to score)
- Distance 3+: WHIFF (miss, you're "exposed", opponent gets free advance)

PARRY MECHANICS:
- If opponent lunged: RIPOSTE (you score instead)
- If opponent didn't lunge: wasted turn

SPECIAL CASES:
- Both lunge at distance 1: DOUBLE HIT (both score)
- Both advance to distance 1: CLASH (distance stays 1)
- After scoring: distance resets to 4

WIN CONDITIONS:
- First to 3 touches
- If 30 turns reached: most touches wins
- If tied at 30 turns: sudden death

TURN TIMER: 5 minutes per turn. Miss = advance.

API FORMAT:
- Join: POST /api/join {"name":"YourName"}
- Move: POST /api/move {"token":"...","move":"lunge"}
- State: GET /api/state/:token

All responses include current state and valid moves.`);
});

// POST /api/join — join matchmaking queue
app.post('/api/join', joinLimiter, (req, res) => {
  const name = (req.body && req.body.name) || 'Anonymous';
  const token = genToken();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  // Clean stale queue entries
  const now = Date.now();
  while (queue.length > 0 && now - queue[0].timestamp > QUEUE_TIMEOUT_MS) {
    const stale = queue.shift();
    removeFromQueueDB(stale.token);
    console.log(`[QUEUE] ${new Date().toISOString()} TIMEOUT name="${stale.name}" waited=${Math.round((now - stale.timestamp)/1000)}s`);
  }

  // Find opponent (prevent self-matching)
  const opponentIdx = queue.findIndex(q => q.name !== name || q.ip !== ip);
  if (opponentIdx >= 0) {
    // Match with waiting player
    const opponent = queue.splice(opponentIdx, 1)[0];
    // Remove opponent from database queue
    removeFromQueueDB(opponent.token);
    
    const gameId = matchPlayers(opponent.token, opponent.name, token, name);
    const game = games.get(gameId);
    console.log(`[MATCH] ${new Date().toISOString()} game=${gameId} p1="${opponent.name}" p2="${name}"`);

    res.json({
      token,
      status: 'matched',
      gameId,
      playerId: 'p2',
      opponent: opponent.name,
      state: compactState(game, 'p2'),
      stateJson: getGameState(game, 'p2'),
      warning: '⚠️ 5 MINUTES per turn to POST /api/move. Missing = advance.',
      turnTimeLimit: 300,
    });
  } else {
    // Add to queue
    const entry = { token, name, ip, timestamp: Date.now() };
    queue.push(entry);
    // Save to database
    saveQueueToDB(entry);
    console.log(`[QUEUE] ${new Date().toISOString()} JOIN name="${name}" queueSize=${queue.length}`);
    notifyQueueJoin(name);

    // If wait=true, long-poll until matched
    if (req.body && req.body.wait) {
      entry.waitRes = res;
      const pollInterval = setInterval(() => {
        const info = players.get(token);
        if (info) {
          clearInterval(pollInterval);
          const game = games.get(info.gameId);
          res.json({
            token,
            status: 'matched',
            gameId: info.gameId,
            playerId: info.playerId,
            opponent: info.playerId === 'p1' ? game.p2Name : game.p1Name,
            state: compactState(game, info.playerId),
            stateJson: getGameState(game, info.playerId),
            warning: '⚠️ 5 MINUTES per turn to POST /api/move.',
            turnTimeLimit: 300,
          });
          return;
        }
        // Check if still in queue
        if (!queue.find(q => q.token === token)) {
          clearInterval(pollInterval);
          // Also clean up database
          removeFromQueueDB(token);
          if (!res.headersSent) res.json({ token, status: 'timeout', message: 'Queue expired. POST /api/join again.' });
        }
      }, 2000);
      return;
    }

    res.json({
      token,
      status: 'waiting',
      message: 'Waiting for opponent. Poll GET /api/state/:token or use "wait":true.',
    });
  }
});

// POST /api/move — submit a move
app.post('/api/move', moveLimiter, (req, res) => {
  const { token, move } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  if (!move) return res.status(400).json({ error: 'move required (advance/retreat/lunge/parry)' });

  const info = players.get(token);
  if (!info) return res.status(404).json({ error: 'Unknown token. Join first.' });

  const game = games.get(info.gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  if (game.phase === 'over') {
    return res.json({
      status: 'game_over',
      winner: game.winner,
      turns: game.turn,
      state: compactState(game, info.playerId),
    });
  }
  if (game.phase !== 'input') return res.status(400).json({ error: 'Not in input phase' });
  if (game.moves[info.playerId]) return res.status(400).json({ error: 'Already submitted move this turn' });

  if (!validateMove(move)) {
    return res.status(400).json({ error: 'move must be: advance/retreat/lunge/parry' });
  }

  game.moves[info.playerId] = move;

  // Bot auto-move for practice mode
  if (game.botDifficulty && !game.moves[game.botSide || 'p2']) {
    const botState = getGameState(game, game.botSide || 'p2');
    game.moves[game.botSide || 'p2'] = botMove(botState, game.botDifficulty);
  }

  // Check if both players have moved
  const bothMoved = game.moves.p1 && game.moves.p2;
  if (bothMoved) {
    resolveIfReady(info.gameId);
    const state = getGameState(game, info.playerId);
    return res.json({
      status: game.phase === 'over' ? 'game_over' : 'resolved',
      turn: game.turn,
      state: compactState(game, info.playerId),
      stateJson: state,
      winner: game.winner,
    });
  }

  // Wait mode for blocking until opponent moves
  if (req.body.wait) {
    if (!game.moveWaiters) game.moveWaiters = [];
    const waitPromise = new Promise((resolve) => {
      game.moveWaiters.push({ resolve });
    });

    waitPromise.then(() => {
      const postState = getGameState(game, info.playerId);
      res.json({
        status: game.phase === 'over' ? 'game_over' : 'resolved',
        turn: game.turn,
        state: compactState(game, info.playerId),
        stateJson: postState,
        winner: game.winner,
      });
    });
    return;
  }

  res.json({
    status: 'waiting_for_opponent',
    message: 'Move accepted. Poll GET /api/state/:token for result.',
  });
});

// GET /api/state/:token — get current game state
app.get('/api/state/:token', (req, res) => {
  const info = players.get(req.params.token);
  if (!info) return res.status(404).json({ error: 'Unknown token' });

  const game = games.get(info.gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });

  const state = getGameState(game, info.playerId);
  const isYourTurn = game.phase !== 'over' && !game.moves[info.playerId];
  
  res.json({
    status: game.phase === 'over' ? 'game_over' : (game.moves[info.playerId] ? 'waiting_for_opponent' : 'your_turn'),
    turn: game.turn,
    phase: game.phase,
    state: compactState(game, info.playerId),
    stateJson: state,
    winner: game.winner,
    gameId: info.gameId,
    playerId: info.playerId,
    ...(isYourTurn && { 
      action_required: '⚠️ POST /api/move with {"token":"'+req.params.token+'","move":"MOVE"} — 5 MINUTE LIMIT!', 
      turnTimeLimit: 300 
    }),
  });
});

// POST /api/practice — play vs bot
app.post('/api/practice', (req, res) => {
  const { difficulty = 'medium', name = 'Player' } = req.body || {};
  const token = genToken();
  const id = `bot_${gameIdCounter++}`;
  const game = createGame(id);
  game.phase = 'input';
  game.botDifficulty = difficulty;
  game.botSide = 'p2';
  game.p1Name = name;
  game.p2Name = `Bot(${difficulty})`;
  game.p1Token = token;
  game.moveWaiters = [];
  games.set(id, game);
  players.set(token, { gameId: id, playerId: 'p1', name });

  startTurnTimer(id);
  
  // Save practice game to database
  saveGameToDB(game);

  const state = getGameState(game, 'p1');
  res.json({
    token,
    status: 'matched',
    gameId: id,
    playerId: 'p1',
    opponent: game.p2Name,
    state: compactState(game, 'p1'),
    stateJson: state,
    warning: '⚠️ 5 MINUTES per turn to POST /api/move.',
  });
});

// GET /api/status — server health
app.get('/api/status', (req, res) => {
  const activeGames = Array.from(games.values()).filter(g => g.phase !== 'over').length;
  res.json({
    status: 'running',
    activeGames,
    queueSize: queue.length,
    completedGames: completedGames.length,
    uptime: process.uptime(),
  });
});

// POST /api/exhibition — bot vs bot match for spectators
app.post('/api/exhibition', (req, res) => {
  // Check if there's already an active exhibition
  for (const [id, game] of games) {
    if (game.exhibition && game.phase !== 'over') {
      return res.json({ gameId: id, status: 'already_running', message: 'Exhibition match in progress' });
    }
  }

  const gameId = 'ex_' + (++gameIdCounter);
  const d1 = req.body?.p1Difficulty || 'hard';
  const d2 = req.body?.p2Difficulty || 'hard';
  const game = {
    id: gameId,
    p1: genToken(), p2: genToken(),
    p1Name: `Bot(${d1})`, p2Name: `Bot(${d2})`,
    scores: { p1: 0, p2: 0 },
    distance: 4,
    turn: 0,
    phase: 'input',
    moves: { p1: null, p2: null },
    lastResult: '',
    winner: null,
    exhibition: true,
    botP1Difficulty: d1,
    botP2Difficulty: d2,
  };
  games.set(gameId, game);
  players.set(game.p1, { gameId, playerId: 'p1' });
  players.set(game.p2, { gameId, playerId: 'p2' });
  
  // Save exhibition game to database
  saveGameToDB(game);

  // Run the exhibition with delays between turns
  function playExhibitionTurn() {
    if (game.phase === 'over') return;
    const p1State = getGameState(game, 'p1');
    const p2State = getGameState(game, 'p2');
    game.moves.p1 = botMove(p1State, game.botP1Difficulty);
    game.moves.p2 = botMove(p2State, game.botP2Difficulty);
    resolveIfReady(gameId);
    if (game.phase !== 'over') {
      setTimeout(playExhibitionTurn, 2000); // 2s between turns for spectators
    }
  }
  setTimeout(playExhibitionTurn, 1000);

  res.json({ gameId, status: 'started', message: `Exhibition: ${game.p1Name} vs ${game.p2Name}` });
});

// GET /api/games — list games
app.get('/api/games', (req, res) => {
  const active = [];
  for (const [id, game] of games) {
    if (game.phase !== 'over') {
      active.push({
        id,
        turn: game.turn,
        phase: game.phase,
        p1: game.p1Name || 'P1',
        p2: game.p2Name || 'P2',
        score: `${game.scores.p1}-${game.scores.p2}`,
        distance: game.distance,
        lastResult: game.lastResult || '',
        winner: game.winner || null,
      });
    }
  }
  res.json({ active, recent: completedGames.slice(-20).reverse(), queue: queue.length });
});

// GET /api/spectate/:gameId — spectator view
app.get('/api/spectate/:gameId', (req, res) => {
  const game = games.get(req.params.gameId);
  if (!game) return res.status(404).json({ error: 'Game not found' });
  
  res.json({
    gameId: req.params.gameId,
    turn: game.turn,
    phase: game.phase,
    distance: game.distance,
    scores: game.scores,
    p1Name: game.p1Name || 'P1',
    p2Name: game.p2Name || 'P2',
    lastResult: game.lastResult,
    winner: game.winner,
  });
});

// ============================================================
// WEBSOCKET — Browser UI
// ============================================================
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
      case 'spectate': {
        const game = games.get(msg.gameId);
        if (!game) return ws.send(JSON.stringify({ type: 'error', message: 'Game not found' }));
        wsClients.set(ws, { gameId: msg.gameId, playerId: null, type: 'spectator' });
        ws.send(JSON.stringify({ 
          type: 'spectate_joined', 
          gameId: msg.gameId,
          game: {
            id: game.id,
            turn: game.turn,
            distance: game.distance,
            scores: game.scores,
            p1Name: game.p1Name || 'P1',
            p2Name: game.p2Name || 'P2',
            lastResult: game.lastResult,
            phase: game.phase,
            winner: game.winner
          }
        }));
        break;
      }
    }
  });
  
  ws.on('close', () => { wsClients.delete(ws); });
});

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Shellsword running on http://0.0.0.0:${PORT}`);
  console.log(`LLM API: POST /api/join, POST /api/move, GET /api/state/:token`);
  console.log(`Rules: GET /api/rules`);
  console.log(`Practice: POST /api/practice`);
});