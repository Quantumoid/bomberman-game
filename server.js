const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const rateLimit = require('express-rate-limit');
const { Worker } = require('worker_threads'); // Added for map generation

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// **Add the following line to trust the first proxy**
app.set('trust proxy', 1);

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// General Rate Limiter to prevent abuse on all endpoints
const generalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 500, // limit each IP to 500 requests per windowMs
    message: 'Too many requests from this IP, please try again after a minute.',
});

app.use(generalLimiter);

// Rate limiter for creating games
const createGameLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 10, // limit each IP to 10 requests per windowMs
    message: { error: 'Too many games created from this IP, please try again after a minute.' }
});

// Health Check Endpoint
app.get('/healthyornot', (req, res) => {
    res.status(200).send('OK');
});

// In-memory storage for games and players
const games = {}; // { password: { players: {}, bombs: [], clients: Set, map: [], powerUps: Map } }
const activePlayers = new Map(); // playerId -> ws
const ipConnections = new Map(); // ip -> count

// Maximum active games
const MAX_ACTIVE_GAMES = 100;

// Predefined player starting positions
const playerStartingPositions = [
    { x: 1, y: 1 },
    { x: 13, y: 1 },
    { x: 1, y: 13 },
    { x: 13, y: 13 }
];

// Increase server timeouts to prevent health check failures
const server = http.createServer(app);
// Increase server timeouts to prevent health check failures
server.keepAliveTimeout = 86400000; // 1 day in milliseconds
server.headersTimeout = 86400000;   // 1 day in milliseconds

// Initialize WebSocket server instance
const wss = new WebSocket.Server({ server });

// Helper function to log messages
function log(level, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

// Function to create a new map with strategic indestructible walls
function createRandomMap() {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const { parentPort } = require('worker_threads');

            const playerStartingPositions = [
                { x: 1, y: 1 },
                { x: 13, y: 1 },
                { x: 1, y: 13 },
                { x: 13, y: 13 }
            ];

            function createInitialMap() {
                const rows = 15;
                const cols = 15;
                const map = Array.from({ length: rows }, () => Array(cols).fill(1));

                for (let y = 0; y < rows; y++) {
                    for (let x = 0; x < cols; x++) {
                        if (y === 0 || y === rows - 1 || x === 0 || x === cols - 1) {
                            map[y][x] = 2; // Border walls
                        } else if (y % 2 === 0 && x % 2 === 0) {
                            map[y][x] = 2; // Indestructible walls
                        }
                    }
                }

                // Clear starting positions and their adjacent tiles
                playerStartingPositions.forEach(pos => {
                    map[pos.y][pos.x] = 0;
                    const directions = [
                        { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
                        { dx: 0, dy: -1 }, { dx: 0, dy: 1 }
                    ];
                    directions.forEach(dir => {
                        const nx = pos.x + dir.dx;
                        const ny = pos.y + dir.dy;
                        if (nx > 0 && nx < cols -1 && ny > 0 && ny < rows -1) {
                            map[ny][nx] = 0;
                        }
                    });
                });

                return map;
            }

            function populateDestructibleWalls(map) {
                for (let y = 1; y < map.length -1; y++) {
                    for (let x = 1; x < map[0].length -1; x++) {
                        if (map[y][x] === 1) {
                            if (Math.random() < 0.7) { // 70% chance to place destructible wall
                                map[y][x] = 1;
                            } else {
                                map[y][x] = 0;
                            }
                        }
                    }
                }
                return map;
            }

            function ensureConnectivity(map) {
                const rows = map.length;
                const cols = map[0].length;
                const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
                const queue = [];

                playerStartingPositions.forEach(pos => {
                    queue.push(pos);
                    visited[pos.y][pos.x] = true;
                });

                while (queue.length > 0) {
                    const { x, y } = queue.shift();
                    const directions = [
                        { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
                        { dx: 0, dy: -1 }, { dx: 0, dy: 1 }
                    ];

                    directions.forEach(dir => {
                        const nx = x + dir.dx;
                        const ny = y + dir.dy;
                        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !visited[ny][nx] && map[ny][nx] !== 2) {
                            visited[ny][nx] = true;
                            queue.push({ x: nx, y: ny });
                        }
                    });
                }

                // Remove unreachable destructible walls
                for (let y = 1; y < rows -1; y++) {
                    for (let x = 1; x < cols -1; x++) {
                        if (map[y][x] === 1 && !visited[y][x]) {
                            map[y][x] = 0;
                        }
                    }
                }

                return map;
            }

            parentPort.on('message', () => {
                try {
                    let map = createInitialMap();
                    map = populateDestructibleWalls(map);
                    map = ensureConnectivity(map);
                    parentPort.postMessage({ map });
                } catch (error) {
                    parentPort.postMessage({ error: error.message });
                }
            });
        `, { eval: true });

        worker.on('message', (message) => {
            if (message.error) {
                reject(new Error(message.error));
            } else {
                resolve(message.map);
            }
        });

        worker.on('error', (error) => {
            reject(error);
        });

        worker.postMessage('start');
    });
}

// Function to check if all starting positions are connected
function areAllStartingPositionsConnected(map) {
    const visited = Array.from({ length: map.length }, () => Array(map[0].length).fill(false));
    const queue = [];

    // Start BFS from the first starting position
    const startPos = playerStartingPositions[0];
    queue.push(startPos);
    visited[startPos.y][startPos.x] = true;

    while (queue.length > 0) {
        const { x, y } = queue.shift();
        const neighbors = [
            { x: x - 1, y },
            { x: x + 1, y },
            { x, y: y - 1 },
            { x, y: y + 1 }
        ];

        neighbors.forEach(({ x: nx, y: ny }) => {
            if (nx >= 0 && nx < map[0].length && ny >= 0 && ny < map.length && !visited[ny][nx] && map[ny][nx] !== 2) {
                visited[ny][nx] = true;
                queue.push({ x: nx, y: ny });
            }
        });
    }

    // Check if all starting positions are visited
    for (let pos of playerStartingPositions) {
        if (!visited[pos.y][pos.x]) {
            return false;
        }
    }
    return true;
}

// Retry logic for createRandomMap
async function createRandomMapWithRetries(maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const map = await createRandomMap();
            if (areAllStartingPositionsConnected(map)) {
                return map;
            } else {
                throw new Error('Generated map does not connect all starting positions.');
            }
        } catch (error) {
            log('warn', `Map generation attempt ${attempt} failed: ${error.message}`);
            if (attempt === maxRetries) {
                throw error;
            }
        }
    }
}

// Function to assign a random spawn point
function assignRandomSpawnPoint(game) {
    const occupiedPositions = new Set(Object.values(game.players).map(player => `${player.x},${player.y}`));
    const availablePositions = playerStartingPositions.filter(pos => !occupiedPositions.has(`${pos.x},${pos.y}`));

    if (availablePositions.length === 0) {
        // Fallback to first position if all are occupied (shouldn't happen)
        return playerStartingPositions[0];
    }

    const randomIndex = Math.floor(Math.random() * availablePositions.length);
    return availablePositions[randomIndex];
}

// Function to check if a position is valid within the map
function isPositionValid(x, y, map) {
    return y >= 0 && y < map.length && x >= 0 && x < map[0].length;
}

// Function to check if a position is walkable within the map
function isWalkable(x, y, game) {
    const tile = game.map[y][x];
    // Check if there's a bomb at this position
    const hasBomb = game.bombs.some(bomb => bomb.x === x && bomb.y === y);
    return (tile === 0 || tile === 3) && !hasBomb;
}

// Function to apply power-up to a player
function applyPowerUp(player, powerUp) {
    if (powerUp === 'bombCapacity') {
        player.maxBombs += 1;
    } else if (powerUp === 'blastRadius') {
        player.bombRadius += 1;
    } else if (powerUp === 'speed') {
        if (player.speed < 4) { // Adjusted maximum speed level to 4
            player.speed += 1;
        }
    } else if (powerUp === 'shield') {
        if (!player.shielded) {
            player.shielded = true;
            const playerWs = activePlayers.get(player.id);
            if (playerWs && playerWs.readyState === WebSocket.OPEN) {
                playerWs.send(JSON.stringify({ type: 'shieldActivated' }));
            }
            // Set a timer to remove the shield after 10 seconds
            setTimeout(() => {
                player.shielded = false;
                if (playerWs && playerWs.readyState === WebSocket.OPEN) {
                    playerWs.send(JSON.stringify({ type: 'shieldDeactivated' }));
                }
            }, 10000); // 10 seconds
        }
    }
}

// Function to check if all brick walls are destroyed
function isAllBricksDestroyed(map) {
    for (let row of map) {
        for (let tile of row) {
            if (tile === 1) {
                return false;
            }
        }
    }
    return true;
}

// Function to broadcast to all clients in a game
function broadcastToGame(gamePassword, data, excludeWs = null) {
    const game = games[gamePassword];
    if (game) {
        game.clients.forEach((client) => {
            if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
                try {
                    client.send(JSON.stringify(data));
                } catch (error) {
                    log('error', `Error broadcasting to client: ${error.message}`);
                }
            }
        });
    }
}

// Function to handle bomb explosion with chain reactions
function explodeBomb(gamePassword, bomb, explodedBombs) {
    const game = games[gamePassword];
    if (!game) return;

    // Prevent processing bombs that have been cleared
    if (!game.bombs.includes(bomb)) return;

    if (explodedBombs.has(bomb)) return;
    explodedBombs.add(bomb);

    try {
        // Clear the bomb's timeout if it exists
        if (bomb.timerId) {
            clearTimeout(bomb.timerId);
            bomb.timerId = null;
        }

        // Remove bomb from game
        game.bombs = game.bombs.filter(b => b !== bomb);
        const player = game.players[bomb.owner];
        if (player) {
            player.currentBombs--;
        }

        // Update the map and notify clients
        const destroyedBricks = [];
        const explosionPositions = [{ x: bomb.x, y: bomb.y }];

        const directions = [
            { dx: -1, dy: 0 }, // Left
            { dx: 1, dy: 0 },  // Right
            { dx: 0, dy: -1 }, // Up
            { dx: 0, dy: 1 }   // Down
        ];

        const newPowerUps = []; // Collect new power-ups generated during this explosion

        directions.forEach(dir => {
            for (let i = 1; i <= bomb.radius; i++) {
                const pos = { x: bomb.x + dir.dx * i, y: bomb.y + dir.dy * i };
                if (isPositionValid(pos.x, pos.y, game.map)) {
                    const tile = game.map[pos.y][pos.x];
                    if (tile === 2) {
                        // Stop if the explosion hits an indestructible wall
                        break;
                    } else {
                        explosionPositions.push(pos);
                        if (tile === 1) {
                            // Destroy brick wall
                            game.map[pos.y][pos.x] = 0;
                            destroyedBricks.push({ x: pos.x, y: pos.y });

                            // Random chance to generate a power-up
                            if (Math.random() < 0.66) { // 66% chance
                                const powerUpTypeRandom = Math.random();
                                let powerUpType = 'bombCapacity';
                                if (powerUpTypeRandom < 0.35) {
                                    powerUpType = 'bombCapacity';
                                } else if (powerUpTypeRandom < 0.70) {
                                    powerUpType = 'blastRadius';
                                } else if (powerUpTypeRandom < 0.85) {
                                    powerUpType = 'speed';
                                } else {
                                    powerUpType = 'shield';
                                }

                                const key = `${pos.x},${pos.y}`;
                                game.powerUps.set(key, powerUpType);
                                game.map[pos.y][pos.x] = 3; // Power-up tile
                                newPowerUps.push({ x: pos.x, y: pos.y, type: powerUpType });
                            }
                            // Stop after destroying a brick wall
                            break;
                        }
                    }
                } else {
                    break;
                }
            }
        });

        // Include explosionPositions in the message
        broadcastToGame(gamePassword, {
            type: 'bombExploded',
            x: bomb.x,
            y: bomb.y,
            destroyedBricks: destroyedBricks,
            newPowerUps: newPowerUps,
            explosionPositions: explosionPositions // Include explosion positions
        });

        // Handle chain reactions sequentially
        explosionPositions.forEach(pos => {
            game.bombs.forEach(otherBomb => {
                if (otherBomb !== bomb && otherBomb.x === pos.x && otherBomb.y === pos.y && !explodedBombs.has(otherBomb)) {
                    setTimeout(() => {
                        explodeBomb(gamePassword, otherBomb, explodedBombs);
                    }, 500); // 500ms delay for sequential explosions
                }
            });
        });

        // Check for players in the bomb's blast radius
        explosionPositions.forEach(pos => {
            Object.keys(game.players).forEach(pId => {
                const targetPlayer = game.players[pId];
                if (targetPlayer.x === pos.x && targetPlayer.y === pos.y && !targetPlayer.invincible) {
                    if (targetPlayer.shielded) {
                        // Remove shield
                        targetPlayer.shielded = false;
                        const targetWs = activePlayers.get(pId);
                        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                            targetWs.send(JSON.stringify({
                                type: 'shieldDeactivated'
                            }));
                        }
                    } else {
                        // Reset player position
                        const initialPosition = assignRandomSpawnPoint(game);
                        if (isPositionValid(initialPosition.x, initialPosition.y, game.map)) {
                            targetPlayer.x = initialPosition.x;
                            targetPlayer.y = initialPosition.y;
                        } else {
                            targetPlayer.x = 1;
                            targetPlayer.y = 1;
                        }

                        // Set invincibility
                        targetPlayer.invincible = true;
                        setTimeout(() => {
                            targetPlayer.invincible = false;
                        }, 5000); // 5 seconds of invincibility

                        // **Implement Bomb Drop Cooldown After Being Hit**
                        targetPlayer.canDropBomb = false;

                        // Send cooldown state to the affected player
                        const targetWs = activePlayers.get(pId);
                        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                            targetWs.send(JSON.stringify({
                                type: 'bombCooldown',
                                canDropBomb: false
                            }));
                        }

                        // Start cooldown timer
                        setTimeout(() => {
                            targetPlayer.canDropBomb = true;
                            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                                targetWs.send(JSON.stringify({
                                    type: 'bombCooldown',
                                    canDropBomb: true
                                }));
                            }
                        }, 3000); // 3 seconds cooldown

                        // Only award point if the player hit is not the bomb owner
                        if (bomb.owner !== pId) {
                            game.players[bomb.owner].score += 1;
                        }

                        broadcastToGame(gamePassword, {
                            type: 'playerHit',
                            playerId: pId,
                            by: bomb.owner,
                            x: targetPlayer.x,
                            y: targetPlayer.y
                        });

                        // Update player scores on clients
                        broadcastToGame(gamePassword, {
                            type: 'updatePlayerList',
                            players: game.players
                        });
                    }
                }
            });
        });

        // Check if all brick walls are destroyed
        if (isAllBricksDestroyed(game.map)) {
            // Generate a new map
            createRandomMapWithRetries().then(newMap => {
                // Clear all existing bombs and their timeouts
                game.bombs.forEach(bomb => {
                    if (bomb.timerId) clearTimeout(bomb.timerId);
                });
                game.bombs = [];

                game.map = newMap;
                game.powerUps = new Map(); // Reset power-ups

                // Reset players' positions and properties
                Object.keys(game.players).forEach(pId => {
                    const player = game.players[pId];
                    const initialPosition = assignRandomSpawnPoint(game);
                    if (isPositionValid(initialPosition.x, initialPosition.y, game.map)) {
                        player.x = initialPosition.x;
                        player.y = initialPosition.y;
                    } else {
                        player.x = 1;
                        player.y = 1;
                    }
                    player.maxBombs = 1;
                    player.bombRadius = 1;
                    player.currentBombs = 0;
                    player.speed = 1;
                    player.invincible = false;
                    player.shielded = false; // Reset shielded state
                    player.canDropBomb = true; // Reset bomb cooldown state

                    // Notify players about reset cooldown state
                    const playerWs = activePlayers.get(pId);
                    if (playerWs && playerWs.readyState === WebSocket.OPEN) {
                        playerWs.send(JSON.stringify({
                            type: 'bombCooldown',
                            canDropBomb: true
                        }));
                        playerWs.send(JSON.stringify({
                            type: 'shieldDeactivated'
                        }));
                    }
                });

                log('info', `All brick walls destroyed in game ${gamePassword}. Generating a new map.`);

                // Notify clients about the new map
                broadcastToGame(gamePassword, {
                    type: 'newMap',
                    map: game.map,
                    players: game.players,
                    powerUps: [] // Assuming no initial power-ups in new map
                });
            }).catch(error => {
                log('error', `Error generating new map: ${error.message}`);
            });
        }
    } catch (error) {
        log('error', `Error during bomb explosion: ${error.message}`);
    }
}

// Function to sanitize player IDs
function sanitizePlayerId(playerId) {
    return String(playerId).replace(/[^a-zA-Z0-9\-]/g, '');
}

// Function to sanitize passwords
function sanitizePassword(password) {
    return String(password).replace(/[^a-zA-Z0-9\-]/g, '');
}

// Function to sanitize nicknames
function sanitizeNickname(nickname) {
    return String(nickname).substring(0, 20).replace(/[^a-zA-Z0-9 _\-]/g, '');
}

// Function to sanitize chat messages
function sanitizeChatMessage(message) {
    return String(message).substring(0, 200).replace(/[\n\r]/g, '').trim();
}

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    // Use the IP from the X-Forwarded-For header or fallback to remoteAddress
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip && ip.includes(',')) {
        ip = ip.split(',')[0]; // Take the first IP from the list
    }

    log('info', `New WebSocket connection from IP: ${ip}`);

    // Increment connection count for this IP
    const currentConnections = ipConnections.get(ip) || 0;
    if (currentConnections >= 5) { // Limit to 5 connections per IP
        log('warn', `Connection refused from IP: ${ip} due to too many connections.`);
        ws.send(JSON.stringify({ type: 'error', message: 'Maximum connections from this IP exceeded.' }));
        ws.close();
        return;
    }
    ipConnections.set(ip, currentConnections + 1);
    log('info', `Total connections from IP ${ip}: ${currentConnections + 1}`);

    let playerId;
    let gamePassword;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const type = data.type;

            if (type === 'join') {
                playerId = sanitizePlayerId(data.playerId);
                gamePassword = sanitizePassword(data.password);
                const nickname = sanitizeNickname(data.nickname || 'Player');

                if (!gamePassword) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid game password.' }));
                    ws.close(4002, 'Invalid game password.');
                    return;
                }

                const game = games[gamePassword];

                if (!game) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Game not found.' }));
                    ws.close(4003, 'Game not found.');
                    return;
                }

                // Check if playerId is already connected
                if (activePlayers.has(playerId)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Player is already connected.' }));
                    ws.close(4006, 'Player is already connected.');
                    log('warn', `Player ${playerId} attempted to connect multiple times from IP: ${ip}`);
                    return;
                }

                activePlayers.set(playerId, ws);

                const numPlayers = Object.keys(game.players).length;

                // Limit the number of players if necessary
                if (numPlayers >= playerStartingPositions.length) { // Match number of starting positions
                    ws.send(JSON.stringify({ type: 'error', message: 'Game is full.' }));
                    ws.close(4004, 'Game is full.');
                    activePlayers.delete(playerId);
                    return;
                }

                // Assign a random initial position
                let initialPosition = assignRandomSpawnPoint(game);

                // Validate initial position
                if (!isPositionValid(initialPosition.x, initialPosition.y, game.map)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid initial position.' }));
                    ws.close(4005, 'Invalid initial position.');
                    activePlayers.delete(playerId);
                    return;
                }

                // Assign player number based on existing players
                const existingPlayerNumbers = Object.values(game.players).map(p => p.playerNumber);
                let playerNumber = 1;
                while (existingPlayerNumbers.includes(playerNumber)) {
                    playerNumber++;
                }

                game.players[playerId] = {
                    id: playerId,
                    x: initialPosition.x,
                    y: initialPosition.y,
                    nickname: nickname,
                    score: 0,
                    playerNumber: playerNumber,
                    maxBombs: 1, // Default bomb capacity
                    bombRadius: 1, // Default blast radius
                    currentBombs: 0, // Bombs currently placed
                    invincible: false, // Invincibility status
                    speed: 1, // Default speed level
                    shielded: false, // Shield status
                    canDropBomb: true // **Added for bomb drop cooldown**
                };

                game.clients.add(ws);

                // Clear the game timeout since a player has joined
                if (game.timeout) {
                    clearTimeout(game.timeout);
                    game.timeout = null;
                }

                // Send the player's number and current game state to the client
                ws.send(JSON.stringify({
                    type: 'start',
                    message: 'Game started! Use arrow keys to move. Press space to drop a bomb.',
                    players: game.players,
                    playerNumber: game.players[playerId].playerNumber,
                    map: game.map,
                    powerUps: Array.from(game.powerUps).map(([key, value]) => {
                        const [x, y] = key.split(',').map(Number);
                        return { x, y, type: value };
                    }),
                    canDropBomb: game.players[playerId].canDropBomb // **Initial cooldown state**
                }));

                // Notify other clients about the new player
                broadcastToGame(gamePassword, {
                    type: 'newPlayer',
                    playerId,
                    x: initialPosition.x,
                    y: initialPosition.y,
                    playerNumber: game.players[playerId].playerNumber,
                    nickname: nickname,
                    score: 0 // Initial score
                }, ws);

                // Send updated player list to all clients
                broadcastToGame(gamePassword, {
                    type: 'updatePlayerList',
                    players: game.players
                });

                log('info', `Player ${nickname} joined game ${gamePassword} at position (${initialPosition.x}, ${initialPosition.y})`);
            }

            if (data.type === 'move') {
                const game = games[gamePassword];
                if (!game) return;
                const player = game.players[playerId];
                if (!player) return;

                let newX = player.x;
                let newY = player.y;

                switch (data.direction) {
                    case 'ArrowUp':
                        newY = Math.max(0, player.y - 1);
                        break;
                    case 'ArrowDown':
                        newY = Math.min(game.map.length - 1, player.y + 1);
                        break;
                    case 'ArrowLeft':
                        newX = Math.max(0, player.x - 1);
                        break;
                    case 'ArrowRight':
                        newX = Math.min(game.map[0].length - 1, player.x + 1);
                        break;
                    default:
                        break;
                }

                if (isWalkable(newX, newY, game)) {
                    player.x = newX;
                    player.y = newY;

                    // Check for power-up at new position
                    const powerUpKey = `${newX},${newY}`;
                    if (game.powerUps.has(powerUpKey)) {
                        const powerUp = game.powerUps.get(powerUpKey);
                        applyPowerUp(player, powerUp);

                        // Remove power-up from game
                        game.powerUps.delete(powerUpKey);
                        game.map[newY][newX] = 0;

                        // Notify clients to remove power-up from the map
                        broadcastToGame(gamePassword, {
                            type: 'powerUpCollected',
                            x: newX,
                            y: newY
                        });
                    }

                    broadcastToGame(gamePassword, {
                        type: 'update',
                        playerId,
                        x: player.x,
                        y: player.y,
                        direction: data.direction
                    });
                }
            }

            if (data.type === 'placeBomb') {
                const game = games[gamePassword];
                if (!game) return;
                const player = game.players[playerId];
                if (!player) return;

                // **Check Bomb Drop Cooldown**
                if (!player.canDropBomb) {
                    // Optionally, you can send a message to client indicating bomb drop is on cooldown
                    return; // Ignore the bomb drop request
                }

                // Check bomb capacity
                if (player.currentBombs >= player.maxBombs) return;

                // Place bomb
                const bomb = {
                    x: player.x,
                    y: player.y,
                    owner: playerId,
                    radius: player.bombRadius
                };
                game.bombs.push(bomb);
                player.currentBombs++;

                broadcastToGame(gamePassword, {
                    type: 'bombPlaced',
                    x: bomb.x,
                    y: bomb.y
                });

                // Store the timeout ID in the bomb object
                bomb.timerId = setTimeout(() => {
                    explodeBomb(gamePassword, bomb, new Set());
                }, 3000);
            }

            if (data.type === 'chat') {
                const game = games[gamePassword];
                if (!game) return;
                const player = game.players[playerId];
                if (!player) return;

                const chatMessage = sanitizeChatMessage(data.message);
                const nickname = player.nickname;

                if (chatMessage.length === 0) return;

                // Broadcast the chat message to all clients in the game
                broadcastToGame(gamePassword, {
                    type: 'chat',
                    nickname: nickname,
                    message: chatMessage
                });
            }
        } catch (error) {
            log('error', `WebSocket Error handling message: ${error.message}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Internal server error.' }));
        }
    });

    ws.on('close', () => {
        if (gamePassword && playerId && games[gamePassword]) {
            const game = games[gamePassword];
            const player = game.players[playerId];
            if (player) {
                log('info', `Player ${player.nickname} left game ${gamePassword}`);
                delete game.players[playerId];
                game.clients.delete(ws);

                // Notify other clients that a player has left
                broadcastToGame(gamePassword, {
                    type: 'playerLeft',
                    playerId: playerId
                });

                // Update player list on clients
                broadcastToGame(gamePassword, {
                    type: 'updatePlayerList',
                    players: game.players
                });

                // Clean up bombs placed by the leaving player
                game.bombs = game.bombs.filter(bomb => {
                    if (bomb.owner === playerId) {
                        if (bomb.timerId) clearTimeout(bomb.timerId);
                        return false;
                    }
                    return true;
                });
            }
        }

        // Remove playerId from activePlayers map
        if (playerId && activePlayers.has(playerId)) {
            activePlayers.delete(playerId);
        }

        // Decrement the connection count for the IP
        const currentConnections = ipConnections.get(ip) || 1;
        if (currentConnections <= 1) {
            ipConnections.delete(ip);
        } else {
            ipConnections.set(ip, currentConnections - 1);
        }

        log('info', `WebSocket connection from IP: ${ip} closed.`);
    });

    ws.on('error', (error) => {
        log('error', `WebSocket error: ${error.message}`);
    });
});

// Endpoint to create a new game with a unique URL
app.get('/create-game', createGameLimiter, async (req, res, next) => {
    try {
        if (Object.keys(games).length >= MAX_ACTIVE_GAMES) {
            log('warn', `Maximum active games (${MAX_ACTIVE_GAMES}) reached. Cannot create a new game.`);
            return res.status(429).json({ error: 'Too many active games. Please try again later.' });
        }

        const password = uuidv4();
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host;
        const gameUrl = `${protocol}://${host}/game/${password}`;

        log('info', `Creating new game with password: ${password}`);

        const map = await createRandomMapWithRetries();

        games[password] = {
            password: password,
            url: gameUrl,
            players: {},
            bombs: [],
            clients: new Set(),
            createdAt: new Date(),
            map: map,
            powerUps: new Map(),
            timeout: setTimeout(() => {
                if (Object.keys(games[password].players).length === 0) {
                    log('info', `No players joined game ${password} within 5 minutes. Deleting game.`);
                    // Clear all bomb timeouts
                    games[password].bombs.forEach(bomb => {
                        if (bomb.timerId) clearTimeout(bomb.timerId);
                    });
                    delete games[password];
                }
            }, 300000) // 5 minutes in milliseconds
        };
        log('info', `Game created with password: ${password}`);
        res.json({ url: gameUrl });
    } catch (error) {
        log('error', `Error creating game: ${error.message}`);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Serve game page
app.get('/game/:password', (req, res) => {
    const { password } = req.params;
    if (games[password]) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        res.status(404).send("Game not found.");
    }
});

// Global Express Error Handler
app.use((err, req, res, next) => {
    log('error', `Express Error: ${err.message}`);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Function to get the local IP address of the server
function getLocalIPAddress() {
    const networkInterfaces = os.networkInterfaces();
    for (const interfaceName of Object.keys(networkInterfaces)) {
        for (const iface of networkInterfaces[interfaceName]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '0.0.0.0';
}

// Start the server and listen on all network interfaces
server.listen(port, '0.0.0.0', () => {
    log('info', `Server is running on port ${port}`);
    log('info', `Accessible online at http://${getLocalIPAddress()}:${port}`);
});

// Graceful Shutdown
function gracefulShutdown() {
    log('info', 'Received kill signal, shutting down gracefully.');
    server.close(() => {
        log('info', 'Closed out remaining connections.');
        process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
        log('error', 'Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle Uncaught Exceptions and Unhandled Rejections to prevent server crashes
process.on('uncaughtException', (err) => {
    log('error', `Uncaught Exception: ${err.message}`);
    gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    log('error', `Unhandled Rejection at: ${promise} reason: ${reason}`);
    gracefulShutdown();
});
