#!/usr/bin/env node
/**
 * Shellsword Auto-Player — Nox's autonomous fencing agent
 * 
 * Joins the matchmaking queue, plays matches using strategy,
 * logs results. Runs as a daemon via pm2.
 * 
 * Strategy:
 * - Distance 4+: advance (close gap)
 * - Distance 3: advance (70%) or parry (30%) 
 * - Distance 2: parry (60%) or advance (40%)
 * - Distance 1: lunge (50%) or parry (50%)
 * - After scoring: play more conservatively
 * - After being scored on: play more aggressively
 */

const BASE = 'http://localhost:3001/api';
const PLAYER_NAME = 'Nox';
const POLL_INTERVAL = 3000;   // 3s between state polls
const QUEUE_RETRY = 30000;    // 30s between queue attempts
const MAX_GAMES = 100;        // stop after this many games

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.resolve(__dirname, 'auto-player.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function pick(weights) {
  // weights = { move: probability, ... }
  const rand = Math.random();
  let sum = 0;
  for (const [move, prob] of Object.entries(weights)) {
    sum += prob;
    if (rand <= sum) return move;
  }
  return Object.keys(weights)[0];
}

function chooseMove(state) {
  const { distance, score, oppScore, turn } = state;
  const leading = score > oppScore;
  const trailing = score < oppScore;
  const lateGame = turn > 20;

  // Distance-based strategy with momentum adjustments
  if (distance >= 4) {
    return 'advance';
  }
  
  if (distance === 3) {
    if (trailing || lateGame) {
      // More aggressive when behind or late
      return pick({ advance: 0.8, lunge: 0.1, parry: 0.1 });
    }
    return pick({ advance: 0.7, parry: 0.2, lunge: 0.1 });
  }
  
  if (distance === 2) {
    if (trailing) {
      // Aggressive: lunge more
      return pick({ lunge: 0.3, parry: 0.4, advance: 0.3 });
    }
    if (leading) {
      // Conservative: parry-heavy
      return pick({ parry: 0.6, retreat: 0.2, advance: 0.2 });
    }
    return pick({ parry: 0.5, advance: 0.3, lunge: 0.2 });
  }
  
  if (distance === 1) {
    if (trailing) {
      // Must score: lunge-heavy
      return pick({ lunge: 0.65, parry: 0.35 });
    }
    if (leading && lateGame) {
      // Protect lead: parry for riposte
      return pick({ parry: 0.7, retreat: 0.2, lunge: 0.1 });
    }
    return pick({ lunge: 0.5, parry: 0.5 });
  }
  
  return 'advance';
}

async function fetchJSON(url, opts = {}) {
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return resp.json();
}

async function joinQueue() {
  try {
    const data = await fetchJSON(`${BASE}/join`, {
      method: 'POST',
      body: JSON.stringify({ name: PLAYER_NAME }),
    });
    if (data.token) {
      log(`Joined queue → token: ${data.token.slice(0, 8)}...`);
      return data.token;
    }
    if (data.error) {
      log(`Queue error: ${data.error}`);
    }
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
    const data = await fetchJSON(`${BASE}/move`, {
      method: 'POST',
      body: JSON.stringify({ token, move }),
    });
    return data;
  } catch (err) {
    log(`Move submit error: ${err.message}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function playMatch(token) {
  log('Match started!');
  let moveCount = 0;

  while (true) {
    const state = await getState(token);
    if (!state) {
      log('Failed to get state, retrying...');
      await sleep(POLL_INTERVAL);
      continue;
    }

    // Game over
    if (state.winner || state.status === 'finished') {
      const sj = state.stateJson || {};
      const won = state.winner === state.playerId;
      const result = state.winner === 'draw' ? 'DRAW' : (won ? 'WIN' : 'LOSS');
      log(`Game over: ${result} | Score: ${sj.score}-${sj.oppScore} | Turns: ${sj.turn} | Game: ${state.gameId}`);
      return { result, score: sj.score, oppScore: sj.oppScore, turns: sj.turn, gameId: state.gameId };
    }

    // Still waiting for match
    if (state.status === 'waiting_in_queue' || state.status === 'queued') {
      log('Waiting in queue for opponent...');
      await sleep(POLL_INTERVAL * 3);
      continue;
    }

    // Waiting for opponent's move
    if (state.status === 'waiting_for_opponent') {
      await sleep(POLL_INTERVAL);
      continue;
    }

    // Our turn to move
    if (state.phase === 'input' && state.status !== 'waiting_for_opponent') {
      const sj = state.stateJson || {};
      const move = chooseMove(sj);
      moveCount++;
      log(`Turn ${sj.turn}: dist=${sj.distance} score=${sj.score}-${sj.oppScore} → ${move}`);
      
      const result = await submitMove(token, move);
      if (result && result.error) {
        log(`Move rejected: ${result.error}`);
      }
      await sleep(POLL_INTERVAL);
      continue;
    }

    // Unknown state, poll again
    await sleep(POLL_INTERVAL);
  }
}

async function main() {
  log('=== Shellsword Auto-Player started ===');
  let gamesPlayed = 0;
  const results = { wins: 0, losses: 0, draws: 0 };

  while (gamesPlayed < MAX_GAMES) {
    log(`Joining queue (game ${gamesPlayed + 1})...`);
    const token = await joinQueue();
    
    if (!token) {
      log(`No token received, retrying in ${QUEUE_RETRY / 1000}s...`);
      await sleep(QUEUE_RETRY);
      continue;
    }

    const result = await playMatch(token);
    if (result) {
      gamesPlayed++;
      results[result.result === 'WIN' ? 'wins' : result.result === 'LOSS' ? 'losses' : 'draws']++;
      log(`Record: ${results.wins}W-${results.losses}L-${results.draws}D (${gamesPlayed} games)`);
    }

    // Brief pause between games
    await sleep(5000);
  }

  log(`=== Auto-Player finished: ${results.wins}W-${results.losses}L-${results.draws}D ===`);
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
