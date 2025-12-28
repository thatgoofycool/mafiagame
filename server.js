const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Use Railway's PORT or default to 3000
const PORT = process.env.PORT || 3000;

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve index.html from the same directory
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Game state
let lobbies = {};

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('createLobby', ({ lobbyName, maxPlayers, playerName, lobbyCode }) => {
        const lobbyId = lobbyCode || generateLobbyCode();
        lobbies[lobbyId] = {
            id: lobbyId,
            name: lobbyName,
            maxPlayers: maxPlayers,
            players: [],
            status: 'waiting', // waiting, playing, finished
            gamePhase: 'day', // day, night
            dayCount: 0,
            votes: {},
            mafiaVotes: {},
            doctorTarget: null,
            detectiveTarget: null,
            mafiaTarget: null,
            lastKilled: null,
            winner: null
        };

        joinLobby(socket, { lobbyId, playerName });
    });

    socket.on('joinLobby', ({ lobbyId, playerName }) => {
        if (lobbies[lobbyId]) {
            joinLobby(socket, { lobbyId, playerName });
        } else {
            socket.emit('error', 'Lobby not found');
        }
    });

    socket.on('ready', () => {
        const lobby = getLobbyBySocket(socket);
        if (!lobby) return;

        const player = lobby.players.find(p => p.id === socket.id);
        if (player) {
            player.ready = !player.ready;

            // Check if all players are ready
            const allReady = lobby.players.length >= 4 && lobby.players.every(p => p.ready);
            
            if (allReady && lobby.status === 'waiting') {
                startGame(lobby);
            }

            io.to(lobby.id).emit('lobbyUpdate', getLobbyData(lobby));
        }
    });

    socket.on('chatMessage', ({ message }) => {
        const lobby = getLobbyBySocket(socket);
        if (!lobby) return;

        const player = lobby.players.find(p => p.id === socket.id);
        if (!player || !player.alive) return;

        // During night, only mafia can talk to each other
        if (lobby.gamePhase === 'night' && player.role !== 'mafia') {
            return;
        }

        io.to(lobby.id).emit('chatMessage', {
            playerName: player.name,
            message: message,
            role: player.role
        });
    });

    socket.on('vote', ({ targetId }) => {
        const lobby = getLobbyBySocket(socket);
        if (!lobby || lobby.gamePhase !== 'day') return;

        const voter = lobby.players.find(p => p.id === socket.id);
        if (!voter || !voter.alive) return;

        const target = lobby.players.find(p => p.id === targetId);
        if (!target || !target.alive) return;

        lobby.votes[socket.id] = targetId;

        // Check if all alive players have voted
        const alivePlayers = lobby.players.filter(p => p.alive);
        const voteCount = Object.keys(lobby.votes).length;

        if (voteCount >= alivePlayers.length) {
            processVotes(lobby);
        }

        io.to(lobby.id).emit('voteUpdate', {
            votes: lobby.votes,
            players: lobby.players.map(p => ({
                name: p.name,
                id: p.id,
                alive: p.alive
            }))
        });
    });

    socket.on('mafiaKill', ({ targetId }) => {
        const lobby = getLobbyBySocket(socket);
        if (!lobby || lobby.gamePhase !== 'night') return;

        const player = lobby.players.find(p => p.id === socket.id);
        if (!player || player.role !== 'mafia' || !player.alive) return;

        lobby.mafiaVotes[socket.id] = targetId;
        
        const mafiaPlayers = lobby.players.filter(p => p.role === 'mafia' && p.alive);
        if (Object.keys(lobby.mafiaVotes).length >= mafiaPlayers.length) {
            // All mafia voted
            const killCounts = {};
            for (let id in lobby.mafiaVotes) {
                const target = lobby.mafiaVotes[id];
                killCounts[target] = (killCounts[target] || 0) + 1;
            }
            
            let maxVotes = 0;
            let target = null;
            for (let id in killCounts) {
                if (killCounts[id] > maxVotes) {
                    maxVotes = killCounts[id];
                    target = id;
                }
            }
            
            lobby.mafiaTarget = target;
        }

        io.to(lobby.id).emit('gameUpdate', getGameData(lobby, player));
    });

    socket.on('doctorSave', ({ targetId }) => {
        const lobby = getLobbyBySocket(socket);
        if (!lobby || lobby.gamePhase !== 'night') return;

        const player = lobby.players.find(p => p.id === socket.id);
        if (!player || player.role !== 'doctor' || !player.alive) return;

        lobby.doctorTarget = targetId;
        io.to(lobby.id).emit('gameUpdate', getGameData(lobby, player));
    });

    socket.on('detectiveInvestigate', ({ targetId }) => {
        const lobby = getLobbyBySocket(socket);
        if (!lobby || lobby.gamePhase !== 'night') return;

        const player = lobby.players.find(p => p.id === socket.id);
        if (!player || player.role !== 'detective' || !player.alive) return;

        const target = lobby.players.find(p => p.id === targetId);
        if (!target) return;

        lobby.detectiveTarget = targetId;

        // Send investigation result only to detective
        socket.emit('investigationResult', {
            targetName: target.name,
            isMafia: target.role === 'mafia'
        });

        io.to(lobby.id).emit('gameUpdate', getGameData(lobby, player));
    });

    socket.on('nextPhase', () => {
        const lobby = getLobbyBySocket(socket);
        if (!lobby) return;

        // Only allow host to advance phase
        if (lobby.players[0].id !== socket.id) return;

        if (lobby.gamePhase === 'day') {
            lobby.gamePhase = 'night';
            lobby.mafiaVotes = {};
            lobby.doctorTarget = null;
            lobby.detectiveTarget = null;
            lobby.mafiaTarget = null;
            io.to(lobby.id).emit('phaseChange', { phase: 'night' });
        } else {
            // Night ends, process night actions
            processNightActions(lobby);
            lobby.gamePhase = 'day';
            lobby.dayCount++;
            io.to(lobby.id).emit('phaseChange', { phase: 'day' });
        }

        io.to(lobby.id).emit('gameUpdate', getGameData(lobby, lobby.players.find(p => p.id === socket.id)));
    });

    socket.on('disconnect', () => {
        const lobby = getLobbyBySocket(socket);
        if (lobby) {
            lobby.players = lobby.players.filter(p => p.id !== socket.id);
            
            if (lobby.players.length === 0) {
                delete lobbies[lobby.id];
            } else {
                io.to(lobby.id).emit('lobbyUpdate', getLobbyData(lobby));
                io.to(lobby.id).emit('gameUpdate', getGameData(lobby, lobby.players[0]));
            }
        }
        console.log('Player disconnected:', socket.id);
    });
});

function joinLobby(socket, { lobbyId, playerName }) {
    const lobby = lobbies[lobbyId];
    
    if (lobby.players.length >= lobby.maxPlayers) {
        socket.emit('error', 'Lobby is full');
        return;
    }

    const player = {
        id: socket.id,
        name: playerName,
        ready: false,
        alive: true,
        role: null
    };

    lobby.players.push(player);
    socket.join(lobbyId);
    socket.emit('joinedLobby', { lobbyId: lobby.id, playerId: socket.id });
    io.to(lobbyId).emit('lobbyUpdate', getLobbyData(lobby));
}

function startGame(lobby) {
    lobby.status = 'playing';
    lobby.gamePhase = 'day';
    lobby.dayCount = 1;
    
    // Assign roles
    const roles = assignRoles(lobby.players.length);
    shuffleArray(roles);
    
    lobby.players.forEach((player, index) => {
        player.role = roles[index];
    });

    lobby.players.forEach(player => {
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) {
            playerSocket.emit('gameStart', getGameData(lobby, player));
        }
    });

    io.to(lobby.id).emit('lobbyUpdate', getLobbyData(lobby));
}

function assignRoles(playerCount) {
    const roles = [];
    
    if (playerCount >= 12) {
        roles.push('mafia', 'mafia', 'mafia', 'doctor', 'detective');
    } else if (playerCount >= 9) {
        roles.push('mafia', 'mafia', 'doctor', 'detective');
    } else if (playerCount >= 7) {
        roles.push('mafia', 'mafia', 'doctor', 'detective');
    } else if (playerCount >= 5) {
        roles.push('mafia', 'doctor', 'detective');
    }
    
    while (roles.length < playerCount) {
        roles.push('villager');
    }
    
    return roles;
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function processVotes(lobby) {
    const voteCounts = {};
    
    for (let voterId in lobby.votes) {
        const targetId = lobby.votes[voterId];
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }

    let maxVotes = 0;
    let eliminated = null;
    
    for (let playerId in voteCounts) {
        if (voteCounts[playerId] > maxVotes) {
            maxVotes = voteCounts[playerId];
            eliminated = playerId;
        }
    }

    if (eliminated) {
        const player = lobby.players.find(p => p.id === eliminated);
        if (player) {
            player.alive = false;
            lobby.lastKilled = player.name;
            io.to(lobby.id).emit('playerEliminated', {
                playerName: player.name,
                role: player.role
            });
        }
    }

    checkWinCondition(lobby);
    lobby.votes = {};
}

function processNightActions(lobby) {
    let killed = null;

    if (lobby.mafiaTarget && lobby.mafiaTarget !== lobby.doctorTarget) {
        const killedPlayer = lobby.players.find(p => p.id === lobby.mafiaTarget);
        if (killedPlayer) {
            killedPlayer.alive = false;
            killed = killedPlayer;
            lobby.lastKilled = killed.name;
        }
    }

    io.to(lobby.id).emit('nightResult', {
        killed: killed ? killed.name : null
    });

    checkWinCondition(lobby);
}

function checkWinCondition(lobby) {
    const aliveMafia = lobby.players.filter(p => p.role === 'mafia' && p.alive).length;
    const aliveTown = lobby.players.filter(p => p.role !== 'mafia' && p.alive).length;

    if (aliveMafia === 0) {
        lobby.winner = 'town';
        lobby.status = 'finished';
    } else if (aliveMafia >= aliveTown) {
        lobby.winner = 'mafia';
        lobby.status = 'finished';
    }

    if (lobby.winner) {
        io.to(lobby.id).emit('gameEnd', {
            winner: lobby.winner,
            roles: lobby.players.map(p => ({
                name: p.name,
                role: p.role
            }))
        });
    }
}

function getLobbyBySocket(socket) {
    for (let lobbyId in lobbies) {
        if (lobbies[lobbyId].players.find(p => p.id === socket.id)) {
            return lobbies[lobbyId];
        }
    }
    return null;
}

function getLobbyData(lobby) {
    return {
        id: lobby.id,
        name: lobby.name,
        maxPlayers: lobby.maxPlayers,
        players: lobby.players.map(p => ({
            name: p.name,
            ready: p.ready,
            alive: p.alive,
            isYou: false // Client will set this
        })),
        status: lobby.status
    };
}

function getGameData(lobby, player) {
    const mafiaPlayers = lobby.players.filter(p => p.role === 'mafia');
    const aliveMafia = mafiaPlayers.filter(p => p.alive).length;
    const alivePlayers = lobby.players.filter(p => p.alive);

    return {
        phase: lobby.gamePhase,
        dayCount: lobby.dayCount,
        alivePlayers: lobby.players.map(p => ({
            name: p.name,
            alive: p.alive,
            isYou: p.id === player.id
        })),
        mafiaPlayers: mafiaPlayers.map(p => ({
            name: p.name,
            alive: p.alive
        })),
        mafiaCount: aliveMafia,
        playerCount: alivePlayers.length,
        lastKilled: lobby.lastKilled,
        winner: lobby.winner,
        votes: lobby.votes
    };
}

function generateLobbyCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

server.listen(PORT, () => {
    console.log(`Mafia.io server running on port ${PORT}`);
});
