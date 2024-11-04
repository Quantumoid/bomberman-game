const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const os = require('os');
const rateLimit = require('express-rate-limit');
const winston = require('winston');

const app = express();
const port = process.env.PORT || 10000;

// Initialize Winston Logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

// If not in production, log to the console as well
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple(),
    }));
}

// Rate Limiter to prevent abuse
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 200, // limit each IP to 200 requests per windowMs
    message: 'Too many requests from this IP, please try again after a minute.',
});

app.use(limiter);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Health Check Endpoint
app.get('/healthyornot', (req, res) => {
    res.status(200).send('OK');
});

// Initialize the game map
function createInitialMap() {
    return [
        [0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0],
        [0, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 2, 2, 0],
        [1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1],
        [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
        [0, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 0],
        [0, 2, 1, 2, 2, 2, 1, 2, 1, 2, 1, 2, 1, 2, 0],
        [0, 1, 1, 1, 1, 1, 1, 2, 1, 1, 2, 1, 1, 1, 0],
        [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
        [1, 1, 1, 1, 1, 1, 2, 1, 1, 2, 1, 1, 1, 2, 1],
        [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        [0, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 0],
        [0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 2, 1, 0, 0]
    ];
}

// Tile types
// 0: Empty space
// 1: Brick wall (destructible)
// 2: Indestructible wall
// 3: Power-up

// List of player starting positions
const playerStartingPositions = [
    { x: 0, y: 0 },
    { x: 14, y: 14 },
    { x: 0, y: 14 },
    { x: 14, y: 0 },
    { x: 7, y: 0 },
    { x: 7, y: 14 },
    { x: 0, y: 7 },
    { x: 14, y: 7 }
];

// Function to create a new map with random walls, preserving zeros
function createRandomMap() {
    const initialMap = createInitialMap(); // Get the initial map
    const map = [];

    for (let y = 0; y < initialMap.length; y++) {
        map[y] = [];
        for (let x = 0; x < initialMap[y].length; x++) {
            if (initialMap[y][x] === 0) {
                // Keep zeros in the same positions
                map[y][x] = 0;
            } else {
                // Randomly assign ones and twos, but ensure indestructible walls do not block players
                if (isAdjacentToPlayerStart(x, y)) {
                    // Do not place indestructible walls adjacent to player starting positions
                    map[y][x] = 1; // Place a destructible brick wall
                } else {
                    if (Math.random() < 0.2) {
                        // 20% chance to be an indestructible wall
                        map[y][x] = 2;
                    } else {
                        // 80% chance to be a destructible brick wall
                        map[y][x] = 1;
                    }
                }
            }
        }
    }

    // Ensure the map is connected and all destructible bricks are accessible
    connectMap(map);

    return map;
}

// Function to check if a position is adjacent to any player starting position
function isAdjacentToPlayerStart(x, y) {
    for (let pos of playerStartingPositions) {
        const dx = Math.abs(pos.x - x);
        const dy = Math.abs(pos.y - y);
        if ((dx === 1 && dy === 0) || (dx === 0 && dy === 1)) {
            return true;
        }
    }
    return false;
}

// Function to ensure the map is fully connected and all destructible bricks are accessible
function connectMap(map) {
    const rows = map.length;
    const cols = map[0].length;
    const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
    const queue = [];

    // Start BFS from all player starting positions
    playerStartingPositions.forEach(pos => {
        if (!visited[pos.y][pos.x]) {
            queue.push(pos);
            visited[pos.y][pos.x] = true;
        }
    });

    while (queue.length > 0) {
        const { x, y } = queue.shift();

        const neighbors = [
            { x: x - 1, y }, // Left
            { x: x + 1, y }, // Right
            { x, y: y - 1 }, // Up
            { x, y: y + 1 }  // Down
        ];

        neighbors.forEach(({ x: nx, y: ny }) => {
            if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !visited[ny][nx]) {
                const tile = map[ny][nx];
                if (tile !== 2) { // If not an indestructible wall
                    visited[ny][nx] = true;
                    queue.push({ x: nx, y: ny });
                }
            }
        });
    }

    // Identify unreachable destructible bricks and connect them
    let madeProgress = true;
    while (madeProgress) {
        madeProgress = false;
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                if (map[y][x] === 1 && !visited[y][x]) {
                    // Find the nearest reachable tile
                    const path = findPathToVisited(map, visited, x, y);
                    if (path) {
                        // Remove indestructible walls along the path
                        path.forEach(({ x: px, y: py }) => {
                            if (map[py][px] === 2) {
                                map[py][px] = 1; // Change to destructible brick
                            }
                            visited[py][px] = true;
                        });
                        madeProgress = true;
                    }
                }
            }
        }
    }
}

// Helper function to find a path from an unvisited tile to a visited tile
function findPathToVisited(map, visited, startX, startY) {
    const rows = map.length;
    const cols = map[0].length;
    const queue = [{ x: startX, y: startY, path: [] }];
    const seen = Array.from({ length: rows }, () => Array(cols).fill(false));
    seen[startY][startX] = true;

    while (queue.length > 0) {
        const { x, y, path } = queue.shift();

        const neighbors = [
            { x: x - 1, y },
            { x: x + 1, y },
            { x, y: y - 1 },
            { x, y: y + 1 }
        ];

        for (let neighbor of neighbors) {
            const nx = neighbor.x;
            const ny = neighbor.y;

            if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && !seen[ny][nx]) {
                seen[ny][nx] = true;
                const tile = map[ny][nx];
                const newPath = [...path, { x: nx, y: ny }];

                if (visited[ny][nx]) {
                    // Found a path to a visited tile
                    return newPath;
                }

                if (tile === 2 || tile === 1 || tile === 0) {
                    queue.push({ x: nx, y: ny, path: newPath });
                }
            }
        }
    }
    return null; // No path found
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
                    powerUps: Object.keys(game.powerUps).map(key => {
                        const [x, y] = key.split(',').map(Number);
                        return { x, y, type: game.powerUps[key] };
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

                logger.info(`Player ${nickname} joined game ${gamePassword} as Player ${playerNumber}`);
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
                        newY = Math.min(14, player.y + 1);
                        break;
                    case 'ArrowLeft':
                        newX = Math.max(0, player.x - 1);
                        break;
                    case 'ArrowRight':
                        newX = Math.min(14, player.x + 1);
                        break;
                    default:
                        break;
                }

                if (isWalkable(newX, newY, game)) {
                    player.x = newX;
                    player.y = newY;

                    // Check for power-up at new position
                    const powerUpKey = `${newX},${newY}`;
                    if (game.powerUps[powerUpKey]) {
                        const powerUp = game.powerUps[powerUpKey];
                        applyPowerUp(player, powerUp);

                        // Remove power-up from game
                        delete game.powerUps[powerUpKey];
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
            logger.error(`Error handling message: ${error.message}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format.' }));
        }
    });

    ws.on('close', () => {
        if (gamePassword && playerId && games[gamePassword]) {
            const game = games[gamePassword];
            const player = game.players[playerId];
            if (player) {
                logger.info(`Player ${player.nickname} left game ${gamePassword}`);
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
                    logger.info(`Deleting empty game ${gamePassword}`);
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
        logger.error(`WebSocket error: ${error.message}`);
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

// Broadcast to all clients within a specific game
function broadcastToGame(gamePassword, data, excludeWs = null) {
    const game = games[gamePassword];
    if (game) {
        game.clients.forEach((client) => {
            if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
                try {
                    client.send(JSON.stringify(data));
                } catch (error) {
                    logger.error(`Error broadcasting to client: ${error.message}`);
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
                if (pos.x >= 0 && pos.x < 15 && pos.y >= 0 && pos.y < 15) {
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

                                game.powerUps[`${pos.x},${pos.y}`] = powerUpType;
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
                    targetPlayer.x = initialPosition.x;
                    targetPlayer.y = initialPosition.y;

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
            game.map = createRandomMap();
            game.powerUps = {}; // Reset power-ups

            // Reset players' positions and properties
            Object.keys(game.players).forEach(pId => {
                const player = game.players[pId];
                const initialPosition = getPlayerInitialPosition(player.playerNumber);
                player.x = initialPosition.x;
                player.y = initialPosition.y;
                player.maxBombs = 1;
                player.bombRadius = 1;
                player.currentBombs = 0;
                player.speed = 1;
                player.invincible = false;
            });

            logger.info(`All brick walls destroyed in game ${gamePassword}. Generating a new map.`);

            // Notify clients about the new map
            broadcastToGame(gamePassword, {
                type: 'newMap',
                map: game.map,
                players: game.players,
                powerUps: [] // Assuming no initial power-ups in new map
            });
        }
    } catch (error) {
        logger.error(`Error during bomb explosion: ${error.message}`);
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
app.get('/create-game', (req, res) => {
    const password = uuidv4();
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host;
    const gameUrl = `${protocol}://${host}/game/${password}`;

    games[password] = {
        password: password,
        url: gameUrl,
        players: {},
        bombs: [],
        clients: new Set(),
        createdAt: new Date(),
        map: createRandomMap(),
        powerUps: {},
        timeout: setTimeout(() => {
            if (Object.keys(games[password].players).length === 0) {
                logger.info(`No players joined game ${password} within 5 minutes. Deleting game.`);
                // Clear all bomb timeouts
                games[password].bombs.forEach(bomb => {
                    if (bomb.timerId) clearTimeout(bomb.timerId);
                });
                delete games[password];
            }
        }, 300000) // 5 minutes in milliseconds
    };
    logger.info(`Game created with password: ${password}`);
    res.json({ url: gameUrl });
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

// Start the server and listen on all network interfaces
server.listen(port, '0.0.0.0', () => {
    logger.info(`Server is running on port ${port}`);
    logger.info(`Accessible online at http://${getLocalIPAddress()}:${port}`);
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
    logger.info('Received kill signal, shutting down gracefully.');
    server.close(() => {
        logger.info('Closed out remaining connections.');
        process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle Uncaught Exceptions and Unhandled Rejections to prevent server crashes
process.on('uncaughtException', (err) => {
    logger.error(`Uncaught Exception: ${err.message}`);
    // Optionally restart the server or perform cleanup
    gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise} reason: ${reason}`);
    // Optionally restart the server or perform cleanup
    gracefulShutdown();
});
