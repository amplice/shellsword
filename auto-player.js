#!/usr/bin/env node
/**
 * Shellsword Auto-Player v2 — Nox's autonomous fencing agent
 * 
 * Improvements over v1:
 * - Persists token to file, resumes game on restart
 * - Deadlock detection (CLASH loop breaker)
 * - Better distance 1 strategy with retreat
 * - Robust error handling (no crash on fetch failure)
 * - Single-game tracking (never joins queue while in active game)
 */

const BASE = 'http://localhost:3001/api';
const PLAYER_NAME = 'Nox';
const POLL_INTERVAL = 3000;
const QUEUE_RETRY = 15000;       // 15s between queue attempts
const MAX_GAMES = 500;
const STALE_TIMEOUT = 180000;    // 3 min no turn progress = abandon
const FETCH_TIMEOUT = 10000;     // 10s fetch timeout
const MAX_FETCH_ERRORS = 20;     // consecutive errors before giving up on a game

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.resolve(__dirname, 'auto-player.log');
const STATE_FILE = path.resolve(__dirname, 'auto-player-state.json');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

function clearState() {
  try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch {}
}

function pick(weights) {
  const rand = Math.random();
  let sum = 0;
  for (const [move, prob] of Object.entries(weights)) {
    sum += prob;
    if (rand <= sum) return move;
  }
  return Object.keys(weights)[0];
}

// Track recent moves for deadlock detection
let recentDistances = [];
const DEADLOCK_THRESHOLD = 4; // same distance for 4+ turns = deadlocked

function detectDeadlock(distance) {
  recentDistances.push(distance);
  if (recentDistances.length > 10) recentDistances.shift();
  
  if (recentDistances.length >= DEADLOCK_THRESHOLD) {
    const last = recentDistances.slice(-DEADLOCK_THRESHOLD);
    return last.every(d => d === last[0]);
  }
  return false;
}

function resetDeadlockTracking() {
  recentDistances = [];
}

function chooseMove(state) {
  const { distance, score, oppScore, turn } = state;
  const leading = score > oppScore;
  const trailing = score < oppScore;
  const lateGame = turn > 20;
  const deadlocked = detectDeadlock(distance);

  // Deadlock breaker — if stuck at same distance, mix it up
  if (deadlocked) {
    if (distance === 1) {
      // At distance 1 deadlock: retreat to create space, then attack
      return pick({ retreat: 0.45, lunge: 0.35, parry: 0.2 });
    }
    if (distance >= 4) {
      // Far deadlock: force close with lunge gamble or advance
      return pick({ advance: 0.5, lunge: 0.3, parry: 0.2 });
    }
    // Mid-range deadlock: aggressive mix
    return pick({ lunge: 0.4, advance: 0.3, parry: 0.2, retreat: 0.1 });
  }

  // Normal strategy
  if (distance >= 4) {
    return 'advance';
  }
  
  if (distance === 3) {
    if (trailing || lateGame) {
      return pick({ advance: 0.7, lunge: 0.15, parry: 0.15 });
    }
    return pick({ advance: 0.6, parry: 0.25, lunge: 0.15 });
  }
  
  if (distance === 2) {
    if (trailing) {
      return pick({ lunge: 0.35, advance: 0.3, parry: 0.35 });
    }
    if (leading) {
      return pick({ parry: 0.55, retreat: 0.2, advance: 0.15, lunge: 0.1 });
    }
    return pick({ parry: 0.45, advance: 0.25, lunge: 0.2, retreat: 0.1 });
  }
  
  if (distance === 1) {
    if (trailing) {
      return pick({ lunge: 0.55, parry: 0.3, retreat: 0.15 });
    }
    if (leading && lateGame) {
      return pick({ parry: 0.5, retreat: 0.3, lunge: 0.2 });
    }
    // Default at distance 1: lunge/parry/retreat mix (never just lunge/parry)
    return pick({ lunge: 0.4, parry: 0.4, retreat: 0.2 });
  }
  
  return 'advance';
}

async function fetchJSON(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const resp = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...opts,
    });
    return await resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function joinQueue() {
  try {
    const data = await fetchJSON(`${BASE}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: PLAYER_NAME }),
    });
    if (data.token) {
      log(`Joined queue → token: ${data.token.slice(0, 8)}...`);
      saveState({ token: data.token, joinedAt: Date.now() });
      return data.token;
    }
    if (data.error) log(`Queue error: ${data.error}`);
    return null;
  } catch (err) {
    log(`Queue fetch error: ${err.message}`);
    return null;
  }
}

async function getState(token) {
  try {
    return await fetchJSON(`${BASE}/state/${token}`);
  } catch (err) {
    log(`State fetch error: ${err.message}`);
    return null;
  }
}

async function submitMove(token, move) {
  try {
    return await fetchJSON(`${BASE}/move`, {
      method: 'POST',
      body: JSON.stringify({ token, move }),
    });
  } catch (err) {
    log(`Move submit error: ${err.message}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function playMatch(token) {
  log('Playing match...');
  let lastTurn = -1;
  let lastTurnChangeTime = Date.now();
  let consecutiveErrors = 0;
  let unknownTokenRetries = 0;
  const MAX_UNKNOWN_RETRIES = 40; // ~2 min of waiting for match at 3s intervals

  while (true) {
    const state = await getState(token);
    
    if (!state) {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_FETCH_ERRORS) {
        log(`Too many consecutive errors (${consecutiveErrors}) — abandoning game`);
        clearState();
        return { result: 'ERROR', turns: lastTurn };
      }
      await sleep(POLL_INTERVAL * 2); // back off on errors
      continue;
    }
    consecutiveErrors = 0; // reset on success

    // Unknown token — might still be in queue waiting for match
    if (state.error && (state.error.includes('Unknown token') || state.error.includes('unknown'))) {
      unknownTokenRetries++;
      if (unknownTokenRetries >= MAX_UNKNOWN_RETRIES) {
        log(`Still unknown after ${unknownTokenRetries} retries — giving up`);
        clearState();
        return { result: 'CLEANED', turns: lastTurn };
      }
      if (unknownTokenRetries % 10 === 0) {
        log(`Waiting for match... (${unknownTokenRetries}/${MAX_UNKNOWN_RETRIES})`);
      }
      await sleep(POLL_INTERVAL);
      continue;
    }
    unknownTokenRetries = 0; // matched!

    // Other server error (not unknown token)
    if (state.error) {
      log(`Server error: ${state.error} — game may be cleaned up`);
      clearState();
      return { result: 'CLEANED', turns: lastTurn };
    }

    const currentTurn = state.stateJson?.turn ?? state.turn ?? -1;
    if (currentTurn !== lastTurn) {
      lastTurn = currentTurn;
      lastTurnChangeTime = Date.now();
    }

    // Stale game detection
    if (Date.now() - lastTurnChangeTime > STALE_TIMEOUT && state.status === 'waiting_for_opponent') {
      log(`Stale game (${Math.round(STALE_TIMEOUT/1000)}s no progress) — abandoning`);
      clearState();
      return { result: 'ABANDONED', turns: currentTurn, gameId: state.gameId };
    }

    // Game over
    if (state.winner || state.status === 'finished') {
      const sj = state.stateJson || {};
      const won = state.winner === state.playerId;
      const result = state.winner === 'draw' || state.winner === 'sudden_death' ? 'DRAW' : (won ? 'WIN' : 'LOSS');
      log(`Game over: ${result} | Score: ${sj.score}-${sj.oppScore} | Turns: ${sj.turn} | Game: ${state.gameId}`);
      clearState();
      resetDeadlockTracking();
      return { result, score: sj.score, oppScore: sj.oppScore, turns: sj.turn, gameId: state.gameId };
    }

    // Waiting in queue
    if (state.status === 'waiting_in_queue' || state.status === 'queued') {
      await sleep(POLL_INTERVAL * 3);
      continue;
    }

    // Waiting for opponent's move
    if (state.status === 'waiting_for_opponent') {
      await sleep(POLL_INTERVAL);
      continue;
    }

    // Our turn
    if (state.phase === 'input' && state.status !== 'waiting_for_opponent') {
      const sj = state.stateJson || {};
      const move = chooseMove(sj);
      log(`Turn ${sj.turn}: dist=${sj.distance} score=${sj.score}-${sj.oppScore} → ${move}`);
      
      const result = await submitMove(token, move);
      if (result && result.error) {
        log(`Move rejected: ${result.error}`);
      }
      await sleep(POLL_INTERVAL);
      continue;
    }

    await sleep(POLL_INTERVAL);
  }
}

async function tryResume() {
  const saved = loadState();
  if (!saved || !saved.token) return null;
  
  log(`Resuming saved game (token: ${saved.token.slice(0, 8)}...)`);
  const state = await getState(saved.token);
  
  if (!state || state.error) {
    log('Saved game no longer valid — clearing');
    clearState();
    return null;
  }
  
  if (state.winner || state.status === 'finished') {
    log('Saved game already finished — clearing');
    clearState();
    return null;
  }
  
  log(`Resuming active game: ${state.gameId || 'unknown'}, turn ${state.stateJson?.turn || '?'}`);
  return saved.token;
}

async function main() {
  log('=== Shellsword Auto-Player v2 started ===');
  let gamesPlayed = 0;
  const results = { wins: 0, losses: 0, draws: 0, errors: 0 };

  while (gamesPlayed < MAX_GAMES) {
    // Try to resume existing game first
    let token = await tryResume();
    
    if (!token) {
      log(`Joining queue (game ${gamesPlayed + 1})...`);
      token = await joinQueue();
    }
    
    if (!token) {
      log(`No token, retrying in ${QUEUE_RETRY / 1000}s...`);
      await sleep(QUEUE_RETRY);
      continue;
    }

    const result = await playMatch(token);
    if (result) {
      gamesPlayed++;
      if (result.result === 'WIN') results.wins++;
      else if (result.result === 'LOSS') results.losses++;
      else if (result.result === 'DRAW') results.draws++;
      else results.errors++;
      log(`Record: ${results.wins}W-${results.losses}L-${results.draws}D (${gamesPlayed} games, ${results.errors} errors)`);
    }

    await sleep(5000);
  }

  log(`=== Auto-Player finished: ${results.wins}W-${results.losses}L-${results.draws}D ===`);
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
