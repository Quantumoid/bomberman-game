const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const rateLimit = require('express-rate-limit');

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter for creating games
const createGameLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 10, // limit each IP to 10 requests per windowMs
    message: { error: 'Too many games created from this IP, please try again after a minute.' }
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

// Helper function to log messages
function log(level, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

// Helper function to create a random map
async function createRandomMapWithRetries(retries = 5) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const map = generateRandomMap();
            if (validateMap(map)) {
                return map;
            } else {
                throw new Error('Generated map is invalid.');
            }
        } catch (error) {
            log('warn', `Map generation attempt ${attempt} failed: ${error.message}`);
            if (attempt === retries) {
                throw error;
            }
        }
    }
}

// Function to generate a random map
function generateRandomMap() {
    const size = 15;
    const map = [];
    for (let y = 0; y < size; y++) {
        const row = [];
        for (let x = 0; x < size; x++) {
            if (x === 0 || y === 0 || x === size - 1 || y === size - 1) {
                row.push(2); // Indestructible walls around the border
            } else if (x % 2 === 0 && y % 2 === 0) {
                row.push(2); // Indestructible walls
            } else {
                // Randomly place brick walls or empty space
                row.push(Math.random() < 0.7 ? 1 : 0); // 70% chance of brick wall
            }
        }
        map.push(row);
    }
    return map;
}

// Function to validate the map
function validateMap(map) {
    // Ensure there are at least some empty spaces for players
    let emptyCount = 0;
    for (let row of map) {
        for (let tile of row) {
            if (tile === 0) emptyCount++;
        }
    }
    return emptyCount > 50; // Arbitrary threshold
}

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket server instance
const wss = new WebSocket.Server({ server });

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
                                } else if (powerUpTypeRandom < 0.90) {
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
                if (targetPlayer.x === pos.x && targetPlayer.y === pos.y && !targetPlayer.invincible && !targetPlayer.shielded) {
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

                    // Update player list on clients
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

// Function to check if a position is valid within the map
function isPositionValid(x, y, map) {
    return y >= 0 && y < map.length && x >= 0 && x < map[0].length;
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

// Function to check if a position is walkable within the map
function isWalkable(x, y, game) {
    return isPositionValid(x, y, game.map) && (game.map[y][x] === 0 || game.map[y][x] === 3);
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

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    // Increment connection count for this IP
    const currentConnections = ipConnections.get(ip) || 0;
    if (currentConnections >= 5) { // Limit to 5 connections per IP
        log('warn', `Connection refused from IP: ${ip} due to too many connections.`);
        ws.send(JSON.stringify({ type: 'error', message: 'Maximum connections from this IP exceeded.' }));
        ws.close();
        return;
    }
    ipConnections.set(ip, currentConnections + 1);
    log('info', `New WebSocket connection from IP: ${ip}. Total connections from this IP: ${currentConnections + 1}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            const type = data.type;

            if (type === 'join') {
                let { playerId, password, nickname } = data;
                playerId = sanitizePlayerId(playerId);
                password = sanitizePassword(password);
                nickname = sanitizeNickname(nickname);

                if (!games[password]) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid game password.' }));
                    return;
                }

                const game = games[password];

                if (Object.keys(game.players).length >= playerStartingPositions.length) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Game is full.' }));
                    return;
                }

                // Assign player number based on existing players
                const existingPlayerNumbers = Object.values(game.players).map(p => p.playerNumber);
                let playerNumber = 1;
                while (existingPlayerNumbers.includes(playerNumber)) {
                    playerNumber++;
                }

                // Assign a random spawn point
                const initialPosition = assignRandomSpawnPoint(game);

                game.players[playerId] = {
                    id: playerId,
                    nickname: nickname,
                    x: initialPosition.x,
                    y: initialPosition.y,
                    playerNumber: playerNumber,
                    maxBombs: 1,
                    bombRadius: 1,
                    currentBombs: 0,
                    speed: 1,
                    invincible: false,
                    shielded: false,
                    canDropBomb: true,
                    score: 0
                };

                game.clients.add(ws);
                activePlayers.set(playerId, ws);

                log('info', `Player ${nickname} (${playerId}) joined game ${password} at position (${initialPosition.x}, ${initialPosition.y})`);

                // Send start message to the new player
                ws.send(JSON.stringify({
                    type: 'start',
                    playerNumber: playerNumber,
                    map: game.map,
                    powerUps: Array.from(game.powerUps.entries()).map(([key, type]) => {
                        const [x, y] = key.split(',').map(Number);
                        return { x, y, type };
                    }),
                    players: game.players
                }));

                // Notify other clients about the new player
                broadcastToGame(password, {
                    type: 'newPlayer',
                    playerId: playerId,
                    nickname: nickname,
                    x: initialPosition.x,
                    y: initialPosition.y,
                    playerNumber: playerNumber,
                    players: game.players
                }, ws);

                // Update player list on all clients
                broadcastToGame(password, {
                    type: 'updatePlayerList',
                    players: game.players
                });
            } else if (type === 'move') {
                const { direction, playerId, password } = data;
                const sanitizedPlayerId = sanitizePlayerId(playerId);
                const sanitizedPassword = sanitizePassword(password);

                if (!games[sanitizedPassword]) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid game password.' }));
                    return;
                }

                const game = games[sanitizedPassword];
                const player = game.players[sanitizedPlayerId];
                if (!player) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Player not found in this game.' }));
                    return;
                }

                let newX = player.x;
                let newY = player.y;

                if (direction === 'ArrowUp') newY--;
                if (direction === 'ArrowDown') newY++;
                if (direction === 'ArrowLeft') newX--;
                if (direction === 'ArrowRight') newX++;

                if (isWalkable(newX, newY, game)) {
                    player.x = newX;
                    player.y = newY;

                    // Notify all clients about the movement
                    broadcastToGame(sanitizedPassword, {
                        type: 'update',
                        playerId: sanitizedPlayerId,
                        x: newX,
                        y: newY,
                        direction: direction,
                        players: game.players
                    });
                }
            } else if (type === 'placeBomb') {
                const { playerId, password } = data;
                const sanitizedPlayerId = sanitizePlayerId(playerId);
                const sanitizedPassword = sanitizePassword(password);

                if (!games[sanitizedPassword]) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid game password.' }));
                    return;
                }

                const game = games[sanitizedPassword];
                const player = game.players[sanitizedPlayerId];
                if (!player) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Player not found in this game.' }));
                    return;
                }

                if (player.currentBombs >= player.maxBombs) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You have reached the maximum number of bombs.' }));
                    return;
                }

                if (!player.canDropBomb) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Bomb drop is on cooldown.' }));
                    return;
                }

                const bombX = player.x;
                const bombY = player.y;

                // Check if there's already a bomb on this tile
                const existingBomb = game.bombs.find(b => b.x === bombX && b.y === bombY);
                if (existingBomb) {
                    ws.send(JSON.stringify({ type: 'error', message: 'There is already a bomb on this tile.' }));
                    return;
                }

                // Place the bomb
                const bomb = {
                    owner: sanitizedPlayerId,
                    x: bombX,
                    y: bombY,
                    radius: player.bombRadius,
                    timerId: null
                };
                game.bombs.push(bomb);
                player.currentBombs++;

                // Notify all clients about the bomb placement
                broadcastToGame(sanitizedPassword, {
                    type: 'bombPlaced',
                    x: bombX,
                    y: bombY
                });

                // Set a timer for the bomb to explode after 3 seconds
                bomb.timerId = setTimeout(() => {
                    explodeBomb(sanitizedPassword, bomb, new Set());
                }, 3000);
            } else if (type === 'chat') {
                const { playerId, password, message } = data;
                const sanitizedPlayerId = sanitizePlayerId(playerId);
                const sanitizedPassword = sanitizePassword(password);
                const sanitizedMessage = sanitizeChatMessage(message);

                if (!games[sanitizedPassword]) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid game password.' }));
                    return;
                }

                const game = games[sanitizedPassword];
                const player = game.players[sanitizedPlayerId];
                if (!player) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Player not found in this game.' }));
                    return;
                }

                // Broadcast chat message to all clients in the game
                broadcastToGame(sanitizedPassword, {
                    type: 'chat',
                    nickname: player.nickname,
                    message: sanitizedMessage
                });
            }
        } catch (error) {
            log('error', `WebSocket Error handling message: ${error.message}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Internal server error.' }));
        }
    });

    ws.on('close', () => {
        // Handle player disconnection
        let gamePassword = null;
        let playerId = null;

        // Find the game and player associated with this connection
        for (const [password, game] of Object.entries(games)) {
            for (const [pid, player] of Object.entries(game.players)) {
                if (activePlayers.get(pid) === ws) {
                    gamePassword = password;
                    playerId = pid;
                    break;
                }
            }
            if (gamePassword) break;
        }

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

// Function to broadcast updated player list
function broadcastUpdatedPlayerList(gamePassword) {
    const game = games[gamePassword];
    if (game) {
        const playersData = {};
        for (const [pid, player] of Object.entries(game.players)) {
            playersData[pid] = {
                nickname: player.nickname,
                score: player.score,
                speed: player.speed,
                shielded: player.shielded
            };
        }
        broadcastToGame(gamePassword, {
            type: 'updatePlayerList',
            players: playersData
        });
    }
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
