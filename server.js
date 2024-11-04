const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const os = require('os');
const rateLimit = require('express-rate-limit');
const { Worker } = require('worker_threads');

const app = express();
const port = process.env.PORT || 10000;

// Maximum number of active games
const MAX_ACTIVE_GAMES = process.env.MAX_ACTIVE_GAMES ? parseInt(process.env.MAX_ACTIVE_GAMES) : 22;

// Simple Logger Function without Timestamp
function log(level, message) {
    const levelUpper = level.toUpperCase();
    console.log(`[${levelUpper}]: ${message}`);
}

// General Rate Limiter to prevent abuse on all endpoints
const generalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 1000, // limit each IP to 1000 requests per windowMs
    message: 'Too many requests from this IP, please try again after a minute.',
});

app.use(generalLimiter);

// Specific Rate Limiter for /create-game to prevent abuse
const createGameLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 20, // limit each IP to 20 create-game requests per windowMs
    message: 'Too many game creation requests from this IP, please try again after a minute.',
});

app.use(express.static(path.join(__dirname, 'public')));

// Health Check Endpoint
app.get('/healthyornot', (req, res) => {
    res.status(200).send('OK');
});

// Tile types
// 0: Empty space
// 1: Brick wall (destructible)
// 2: Indestructible wall
// 3: Power-up

// List of player starting positions
const playerStartingPositions = [
    { x: 0, y: 0 },
    { x: 7, y: 0 },
    { x: 14, y: 0 },
    { x: 0, y: 7 },
    { x: 14, y: 7 },
    { x: 0, y: 14 },
    { x: 7, y: 14 },
    { x: 14, y: 14 }
];

// Function to create a new map with strategic walls, ensuring full connectivity
function createRandomMap() {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`
            const { parentPort } = require('worker_threads');

            function createInitialMap() {
                const rows = 15;
                const cols = 15;
                const map = Array.from({ length: rows }, () => Array(cols).fill(0));

                // Set borders as indestructible walls
                for (let y = 0; y < rows; y++) {
                    map[y][0] = 2;
                    map[y][cols - 1] = 2;
                }
                for (let x = 0; x < cols; x++) {
                    map[0][x] = 2;
                    map[rows - 1][x] = 2;
                }

                // Randomly place indestructible walls inside the map with symmetry
                for (let y = 1; y < rows - 1; y++) {
                    for (let x = 1; x < Math.floor(cols / 2); x++) {
                        if (Math.random() < 0.2) { // 20% chance to place an indestructible wall
                            map[y][x] = 2;
                            map[y][cols - 1 - x] = 2; // Symmetric placement
                        }
                    }
                }

                // Randomly place destructible walls
                for (let y = 1; y < rows - 1; y++) {
                    for (let x = 1; x < cols - 1; x++) {
                        if (map[y][x] === 0 && !isPlayerStartingPosition(x, y)) {
                            if (Math.random() < 0.3) { // 30% chance to place a destructible wall
                                map[y][x] = 1;
                                map[y][cols - 1 - x] = 1; // Symmetric placement
                            }
                        }
                    }
                }

                return map;
            }

            const playerStartingPositions = [
                { x: 0, y: 0 },
                { x: 7, y: 0 },
                { x: 14, y: 0 },
                { x: 0, y: 7 },
                { x: 14, y: 7 },
                { x: 0, y: 14 },
                { x: 7, y: 14 },
                { x: 14, y: 14 }
            ];

            function isPlayerStartingPosition(x, y) {
                return playerStartingPositions.some(pos => pos.x === x && pos.y === y);
            }

            function generateStrategicWalls(map) {
                // Central horizontal choke point with openings
                const centralY = Math.floor(map.length / 2);
                for (let x = 2; x < map[0].length - 2; x++) {
                    // Leave openings at intervals
                    if (x % 4 !== 0) { // Leave an opening every 4 tiles
                        map[centralY][x] = 2; // Indestructible wall
                    } else {
                        map[centralY][x] = 0; // Opening
                    }
                }

                // Vertical walls in specific columns with openings
                const verticalColumns = [3, 11];
                verticalColumns.forEach(col => {
                    for (let y = 2; y < map.length - 2; y++) {
                        // Leave openings at intervals
                        if (y % 4 !== 0) { // Leave an opening every 4 tiles
                            map[y][col] = 2;
                        } else {
                            map[y][col] = 0; // Opening
                        }
                    }
                });

                return map;
            }

            // Flood Fill to ensure all destructible walls are reachable
            function ensureFullConnectivity(map) {
                const rows = map.length;
                const cols = map[0].length;
                const reachable = Array.from({ length: rows }, () => Array(cols).fill(false));

                // Initialize queue with all player starting positions
                const queue = [...playerStartingPositions];
                queue.forEach(pos => {
                    reachable[pos.y][pos.x] = true;
                });

                // BFS to mark reachable tiles
                while (queue.length > 0) {
                    const { x, y } = queue.shift();
                    const directions = [
                        { dx: -1, dy: 0 },
                        { dx: 1, dy: 0 },
                        { dx: 0, dy: -1 },
                        { dx: 0, dy: 1 }
                    ];

                    directions.forEach(dir => {
                        const nx = x + dir.dx;
                        const ny = y + dir.dy;

                        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !reachable[ny][nx]) {
                            if (map[ny][nx] !== 2) { // Can't pass through indestructible walls
                                reachable[ny][nx] = true;
                                queue.push({ x: nx, y: ny });
                            }
                        }
                    });
                }

                // Check if all destructible walls are reachable
                let allReachable = true;
                for (let y = 0; y < rows; y++) {
                    for (let x = 0; x < cols; x++) {
                        if (map[y][x] === 1 && !reachable[y][x]) {
                            allReachable = false;
                            // Attempt to connect by removing an indestructible wall adjacent to the unreachable wall
                            const directions = [
                                { dx: -1, dy: 0 },
                                { dx: 1, dy: 0 },
                                { dx: 0, dy: -1 },
                                { dx: 0, dy: 1 }
                            ];
                            for (let dir of directions) {
                                const nx = x + dir.dx;
                                const ny = y + dir.dy;
                                if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && map[ny][nx] === 2) {
                                    map[ny][nx] = 1; // Convert to destructible wall
                                    reachable[y][x] = true;
                                    queue.push({ x: x, y: y });
                                    break;
                                }
                            }
                        }
                    }
                }

                if (!allReachable) {
                    // Recursive call to ensure connectivity after adjustments
                    return ensureFullConnectivity(map);
                }

                return map;
            }

            parentPort.on('message', () => {
                try {
                    let map = createInitialMap();

                    // Apply strategic wall placements
                    map = generateStrategicWalls(map);

                    // Ensure full connectivity
                    map = ensureFullConnectivity(map);

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
    const rows = map.length;
    const cols = map[0].length;
    const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
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
            if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !visited[ny][nx] && map[ny][nx] !== 2) {
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

// Create HTTP server and bind to all interfaces
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Increase server timeouts to prevent Render from marking it unhealthy
server.keepAliveTimeout = 120000; // 2 minutes
server.headersTimeout = 120000;    // 2 minutes

// Store all active games
const games = {};

// WebSocket connection handling
wss.on('connection', (ws) => {
    let playerId;
    let gamePassword;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'join') {
                playerId = sanitizePlayerId(data.playerId);
                gamePassword = sanitizePassword(data.password);
                const nickname = sanitizeNickname(data.nickname || 'Player');

                const game = games[gamePassword];

                if (!game) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Game not found.' }));
                    ws.close();
                    return;
                }

                const numPlayers = Object.keys(game.players).length;
                const playerNumber = numPlayers + 1; // Assign player number

                // Limit the number of players if necessary
                if (playerNumber > 8) { // Allow up to 8 players
                    ws.send(JSON.stringify({ type: 'error', message: 'Game is full.' }));
                    ws.close();
                    return;
                }

                // Assign initial positions based on player number
                let initialPosition = getPlayerInitialPosition(playerNumber);

                // Validate initial position
                if (!isPositionValid(initialPosition.x, initialPosition.y, game.map)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid initial position.' }));
                    ws.close();
                    return;
                }

                game.players[playerId] = {
                    x: initialPosition.x,
                    y: initialPosition.y,
                    nickname: nickname,
                    score: 0,
                    playerNumber: playerNumber,
                    maxBombs: 1, // Default bomb capacity
                    bombRadius: 1, // Default blast radius
                    currentBombs: 0, // Bombs currently placed
                    invincible: false, // Invincibility status
                    speed: 1 // Default speed level
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
                    playerNumber: playerNumber,
                    map: game.map,
                    powerUps: Array.from(game.powerUps).map(([key, value]) => {
                        const [x, y] = key.split(',').map(Number);
                        return { x, y, type: value };
                    })
                }));

                // Notify other clients about the new player
                broadcastToGame(gamePassword, {
                    type: 'newPlayer',
                    playerId,
                    x: initialPosition.x,
                    y: initialPosition.y,
                    playerNumber: playerNumber,
                    nickname: nickname,
                    score: 0 // Initial score
                }, ws);

                // Send updated player list to all clients
                broadcastToGame(gamePassword, {
                    type: 'updatePlayerList',
                    players: game.players
                });

                log('info', `Player ${nickname} joined game ${gamePassword} as Player ${playerNumber}`);
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

                // If no clients remain, delete the game
                if (game.clients.size === 0) {
                    log('info', `Deleting empty game ${gamePassword}`);
                    // Clear game creation timeout
                    if (game.timeout) clearTimeout(game.timeout);
                    // Clear remaining bomb timeouts
                    game.bombs.forEach(bomb => {
                        if (bomb.timerId) clearTimeout(bomb.timerId);
                    });
                    delete games[gamePassword];
                }
            }
        }
    });

    ws.on('error', (error) => {
        log('error', `WebSocket error: ${error.message}`);
    });
});

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
    }
}

// Function to get player's initial position based on player number
function getPlayerInitialPosition(playerNumber) {
    return playerStartingPositions[playerNumber - 1] || { x: 0, y: 0 };
}

// Function to check if a position is valid within the map
function isPositionValid(x, y, map) {
    return y >= 0 && y < map.length && x >= 0 && x < map[0].length;
}

// Broadcast to all clients within a specific game
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

// Function to handle bomb explosions with chain reactions
function explodeBomb(gamePassword, bomb, explodedBombs) {
    const game = games[gamePassword];
    if (!game) return;

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
                            if (Math.random() < 0.3) { // 30% chance
                                const powerUpTypeRandom = Math.random();
                                let powerUpType = 'bombCapacity';
                                if (powerUpTypeRandom < 0.33) {
                                    powerUpType = 'bombCapacity';
                                } else if (powerUpTypeRandom < 0.66) {
                                    powerUpType = 'blastRadius';
                                } else {
                                    powerUpType = 'speed';
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
                    // Reset player position
                    const initialPosition = getPlayerInitialPosition(targetPlayer.playerNumber);
                    if (isPositionValid(initialPosition.x, initialPosition.y, game.map)) {
                        targetPlayer.x = initialPosition.x;
                        targetPlayer.y = initialPosition.y;
                    } else {
                        targetPlayer.x = 0;
                        targetPlayer.y = 0;
                    }

                    // Set invincibility
                    targetPlayer.invincible = true;
                    setTimeout(() => {
                        targetPlayer.invincible = false;
                    }, 5000); // 5 seconds of invincibility

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
            });
        });

        // Check if all brick walls are destroyed
        if (isAllBricksDestroyed(game.map)) {
            // Generate a new map
            createRandomMapWithRetries().then(newMap => {
                game.map = newMap;
                game.powerUps = new Map(); // Reset power-ups

                // Reset players' positions and properties
                Object.keys(game.players).forEach(pId => {
                    const player = game.players[pId];
                    const initialPosition = getPlayerInitialPosition(player.playerNumber);
                    if (isPositionValid(initialPosition.x, initialPosition.y, game.map)) {
                        player.x = initialPosition.x;
                        player.y = initialPosition.y;
                    } else {
                        player.x = 0;
                        player.y = 0;
                    }
                    player.maxBombs = 1;
                    player.bombRadius = 1;
                    player.currentBombs = 0;
                    player.speed = 1;
                    player.invincible = false;
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

// Function to check if a position is walkable
function isWalkable(x, y, game) {
    const tile = game.map[y][x];
    // Check if there's a bomb at this position
    const hasBomb = game.bombs.some(bomb => bomb.x === x && bomb.y === y);
    return (tile === 0 || tile === 3) && !hasBomb;
}

// Global Express Error Handler
app.use((err, req, res, next) => {
    log('error', `Express Error: ${err.message}`);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Start the server and listen on all network interfaces
server.listen(port, '0.0.0.0', () => {
    log('info', `Server is running on port ${port}`);
    log('info', `Accessible online at http://${getLocalIPAddress()}:${port}`);
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
