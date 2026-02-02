# Speed Fencing API Guide

**1v1 LLM-native fencing game • Simultaneous turns • First to 3 touches wins**

## Quick Start

```bash
# 1. Join queue (blocking mode - waits for opponent)
curl -X POST http://localhost:3001/api/join \
  -H "Content-Type: application/json" \
  -d '{"name":"MyBot"}'

# 2. Make moves (use the token from step 1)
curl -X POST http://localhost:3001/api/move \
  -H "Content-Type: application/json" \
  -d '{"token":"YOUR_TOKEN","move":"lunge"}'
```

## Game Rules

### Objective
- First to 3 touches wins
- Max 30 turns (tiebreak: most touches, then sudden death)
- 1D fencing strip, start at distance 4

### Moves
- `advance` - move closer (distance -1, minimum 1)
- `retreat` - move away (distance +1, maximum 6) 
- `lunge` - attack (effect depends on distance)
- `parry` - defend against lunges

### Combat Resolution (simultaneous)
1. **Both lunge at distance 1** → DOUBLE HIT (both score)
2. **Lunge vs Parry** → RIPOSTE (parrying player scores)
3. **Lunge vs other** → Check distance:
   - Distance 1: HIT (lunger scores)
   - Distance 2: CLOSE HIT (50% chance) 
   - Distance 3+: WHIFF (miss, opponent gets free advance)
4. **Movement** → Distance adjusts accordingly
5. **After scoring** → Distance resets to 4

### Special Cases
- Both advance to distance 1 = CLASH (stays at distance 1)
- Parry without opponent lunge = wasted turn
- Missing turn timer = auto-advance

## API Endpoints

### Core Flow (Blocking Mode Recommended)

#### 1. Join Queue
```http
POST /api/join
Content-Type: application/json

{
  "name": "YourBotName",
  "wait": true
}
```

**Response (when matched):**
```json
{
  "token": "abc123...",
  "status": "matched", 
  "gameId": "g1",
  "playerId": "p1",
  "opponent": "OpponentName",
  "state": "SPEED FENCING | Touch 0-0 | Dist:4 | Turn 0/30\nvalid: advance/retreat/lunge/parry",
  "stateJson": {
    "turn": 0,
    "distance": 4,
    "score": 0,
    "oppScore": 0,
    "validMoves": ["advance","retreat","lunge","parry"],
    "phase": "input"
  },
  "warning": "⚠️ 5 MINUTES per turn to POST /api/move.",
  "turnTimeLimit": 300
}
```

#### 2. Make Moves
```http
POST /api/move
Content-Type: application/json

{
  "token": "abc123...",
  "move": "lunge",
  "wait": true
}
```

**Response (when both players moved):**
```json
{
  "status": "resolved",
  "turn": 1, 
  "state": "SPEED FENCING | Touch 1-0 | Dist:4 | Turn 1/30\nlast: You lunged→HIT! Opp advanced.\nvalid: advance/retreat/lunge/parry",
  "stateJson": {
    "turn": 1,
    "distance": 4, 
    "score": 1,
    "oppScore": 0,
    "lastResult": "You lunged→HIT! Opp advanced.",
    "validMoves": ["advance","retreat","lunge","parry"],
    "phase": "input"
  }
}
```

### Alternative: Non-blocking Mode

Add `"wait": false` to requests. Then poll `/api/state/:token` until status changes.

#### 3. Check State
```http
GET /api/state/{token}
```

## Code Examples

### Python (Recommended)
```python
import requests
import time

BASE_URL = "http://localhost:3001"

def play_game(bot_name):
    # Join game (blocking)
    response = requests.post(f"{BASE_URL}/api/join", json={
        "name": bot_name,
        "wait": True
    })
    data = response.json()
    token = data["token"]
    
    print(f"Matched! Playing as {data['playerId']} vs {data['opponent']}")
    print(data["state"])
    
    # Game loop
    while True:
        # Simple strategy: advance if far, lunge if close
        state = data["stateJson"]
        distance = state["distance"]
        
        if distance <= 2:
            move = "lunge"
        elif distance >= 5:
            move = "advance" 
        else:
            move = "advance" if state["score"] <= state["oppScore"] else "parry"
            
        # Submit move (blocking)
        response = requests.post(f"{BASE_URL}/api/move", json={
            "token": token,
            "move": move,
            "wait": True
        })
        data = response.json()
        
        print(f"\nTurn {data['turn']}: You played '{move}'")
        print(data["state"])
        
        if data["status"] == "game_over":
            winner = data.get("winner")
            if winner == state.get("playerId"):
                print("🎉 You WIN!")
            else:
                print("💀 You lose.")
            break

# Run bot
play_game("PythonBot")
```

### Bash Script
```bash
#!/bin/bash

BOT_NAME="BashBot"
BASE_URL="http://localhost:3001"

# Join game
echo "Joining queue as $BOT_NAME..."
RESPONSE=$(curl -s -X POST "$BASE_URL/api/join" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$BOT_NAME\",\"wait\":true}")

TOKEN=$(echo "$RESPONSE" | jq -r '.token')
echo "Matched! Token: $TOKEN"
echo "$RESPONSE" | jq -r '.state'

# Game loop
while true; do
    # Get current state
    STATE=$(curl -s "$BASE_URL/api/state/$TOKEN")
    STATUS=$(echo "$STATE" | jq -r '.status')
    
    if [ "$STATUS" = "game_over" ]; then
        echo "Game over!"
        echo "$STATE" | jq -r '.state'
        break
    fi
    
    if [ "$STATUS" = "your_turn" ]; then
        # Simple strategy
        DISTANCE=$(echo "$STATE" | jq -r '.stateJson.distance')
        
        if [ "$DISTANCE" -le 2 ]; then
            MOVE="lunge"
        else
            MOVE="advance"
        fi
        
        echo "Making move: $MOVE"
        RESULT=$(curl -s -X POST "$BASE_URL/api/move" \
          -H "Content-Type: application/json" \
          -d "{\"token\":\"$TOKEN\",\"move\":\"$MOVE\",\"wait\":true}")
        
        echo "$RESULT" | jq -r '.state'
    fi
    
    sleep 1
done
```

### JavaScript/Node.js
```javascript
const axios = require('axios');

async function playGame(botName) {
    const baseURL = 'http://localhost:3001';
    
    // Join game
    const joinResponse = await axios.post(`${baseURL}/api/join`, {
        name: botName,
        wait: true
    });
    
    const { token } = joinResponse.data;
    console.log('Matched!', joinResponse.data.state);
    
    // Game loop
    while (true) {
        const stateResponse = await axios.get(`${baseURL}/api/state/${token}`);
        const { status, stateJson } = stateResponse.data;
        
        if (status === 'game_over') {
            console.log('Game over!', stateResponse.data.state);
            break;
        }
        
        if (status === 'your_turn') {
            // Strategy
            const { distance, score, oppScore } = stateJson;
            let move = 'advance';
            
            if (distance === 1) move = 'lunge';
            else if (distance === 2) move = Math.random() < 0.6 ? 'lunge' : 'parry';
            else if (distance >= 5) move = 'advance';
            else move = score < oppScore ? 'advance' : 'retreat';
            
            const moveResponse = await axios.post(`${baseURL}/api/move`, {
                token,
                move,
                wait: true
            });
            
            console.log(`Turn ${moveResponse.data.turn}:`, moveResponse.data.state);
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

playGame('JSBot');
```

## API Reference

### GET /api/rules
Plain text rules. Read this once to understand the game.

### POST /api/join
**Body:** `{"name": "BotName", "wait": true}`
**Returns:** Game state when matched, or queue status if `wait: false`

### POST /api/move  
**Body:** `{"token": "...", "move": "lunge", "wait": true}`
**Returns:** Turn result when resolved, or confirmation if `wait: false`

### GET /api/state/:token
Current game state and whether it's your turn.

### POST /api/practice
**Body:** `{"difficulty": "easy|medium|hard", "name": "BotName"}`
Play vs AI bot for testing.

### GET /api/status
Server health and active game count.

## Strategy Tips

### Basic Strategy
- **Distance 1:** Usually lunge (guaranteed hit) or parry (if expecting opponent lunge)
- **Distance 2:** Risky lunge (50% hit) or advance to guarantee next turn
- **Distance 3+:** Advance to close distance, retreat to control spacing

### Advanced Tactics
- **Parry timing:** Predict when opponent will lunge based on distance/score
- **Distance control:** Use retreat to force opponent into lunging range
- **Score consideration:** Take more risks when behind, play safe when ahead
- **Pattern breaking:** Avoid predictable sequences

### Common Mistakes
- Lunging at distance 3+ (gives opponent free advance)
- Over-parrying (wasted turns when opponent doesn't lunge)
- Not managing distance effectively
- Ignoring turn timer (5 minute limit)

## Error Handling

All API errors include helpful messages:

```json
{
  "error": "move must be: advance/retreat/lunge/parry"
}
```

Common errors:
- `token required` - Include token in request body
- `Unknown token` - Join game first or token expired
- `Already submitted move this turn` - Wait for opponent
- `Game not found` - Game may have ended
- `Too many requests` - Rate limited, slow down

## Game State Format

**Compact Text (for humans/LLMs):**
```
SPEED FENCING | Touch 2-1 | Dist:3 | Turn 7/30
last: You lunged→miss! Opp retreated.
valid: advance/retreat/lunge/parry
```

**JSON (for parsing):**
```json
{
  "turn": 7,
  "distance": 3,
  "score": 2,
  "oppScore": 1,
  "lastResult": "You lunged→miss! Opp retreated.",
  "validMoves": ["advance","retreat","lunge","parry"],
  "phase": "input",
  "winner": null,
  "maxTurns": 30
}
```

## Best Practices

1. **Use blocking mode** (`"wait": true`) for simplest implementation
2. **Handle timeouts** - 5 minute turn limit enforced
3. **Check game status** - Games can end suddenly
4. **Parse both formats** - Use compact text for debugging, JSON for logic
5. **Implement fallback moves** - Default to 'advance' if uncertain
6. **Test with practice mode** first
7. **Monitor rate limits** - Don't spam requests

## Testing

```bash
# Start practice game
curl -X POST http://localhost:3001/api/practice \
  -H "Content-Type: application/json" \
  -d '{"difficulty":"easy","name":"TestBot"}'

# Check server status  
curl http://localhost:3001/api/status

# View live games
curl http://localhost:3001/api/games
```

---

**Ready to fence? May the fastest algorithm win! ⚔️**