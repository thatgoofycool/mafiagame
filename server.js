const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Game state
const lobbies = {};
const players = {};
const ROLES = ['mafia', 'doctor', 'detective', 'villager'];

// Generate random lobby code
function generateLobbyCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// Shuffle array
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Create a new lobby
  socket.on('createLobby', ({ username, lobbyName, maxPlayers }) => {
    const lobbyCode = generateLobbyCode();
    lobbies[lobbyCode] = {
      code: lobbyCode,
      name: lobbyName,
      maxPlayers: maxPlayers,
      players: [],
      host: socket.id,
      phase: 'waiting', // waiting, day, night, ended
      dayCount: 0,
      votes: {},
      mafiaTarget: null,
      doctorTarget: null,
      detectiveTarget: null
    };

    joinLobby(socket, username, lobbyCode);
    io.to(socket.id).emit('lobbyCreated', { lobbyCode, isHost: true });
  });

  // Join an existing lobby
  socket.on('joinLobby', ({ username, lobbyCode }) => {
    if (!lobbies[lobbyCode]) {
      io.to(socket.id).emit('error', 'Lobby not found');
      return;
    }

    const lobby = lobbies[lobbyCode];
    if (lobby.players.length >= lobby.maxPlayers) {
      io.to(socket.id).emit('error', 'Lobby is full');
      return;
    }

    joinLobby(socket, username, lobbyCode);
    io.to(socket.id).emit('lobbyJoined', { lobbyCode, isHost: false });
  });

  // Toggle ready status
  socket.on('toggleReady', () => {
    const player = players[socket.id];
    if (!player || !lobbies[player.lobbyCode]) return;

    const lobby = lobbies[player.lobbyCode];
    const lobbyPlayer = lobby.players.find(p => p.id === socket.id);
    if (lobbyPlayer) {
      lobbyPlayer.ready = !lobbyPlayer.ready;
      io.to(lobby.code).emit('playerUpdated', lobbyPlayer);

      // Check if all players are ready and start game
      if (lobby.players.length >= 3 && lobby.players.every(p => p.ready)) {
        startGame(lobby.code);
      }
    }
  });

  // Chat message
  socket.on('chatMessage', (message) => {
    const player = players[socket.id];
    if (!player || !lobbies[player.lobbyCode]) return;

    const lobby = lobbies[player.lobbyCode];
    const lobbyPlayer = lobby.players.find(p => p.id === socket.id);
    
    const chatMessage = {
      username: lobbyPlayer.username,
      message: message,
      isMafia: lobbyPlayer.role === 'mafia'
    };

    // During night, mafia can only talk to mafia
    if (lobby.phase === 'night' && lobbyPlayer.role === 'mafia') {
      lobby.players.filter(p => p.role === 'mafia').forEach(p => {
        io.to(p.id).emit('chatMessage', chatMessage);
      });
    } else if (lobby.phase !== 'night') {
      // Public chat during day and waiting
      io.to(lobby.code).emit('chatMessage', chatMessage);
    }
  });

  // Vote for player
  socket.on('vote', (targetId) => {
    const player = players[socket.id];
    if (!player || !lobbies[player.lobbyCode]) return;

    const lobby = lobbies[player.lobbyCode];
    if (lobby.phase !== 'day') return;

    const lobbyPlayer = lobby.players.find(p => p.id === socket.id);
    if (!lobbyPlayer || !lobbyPlayer.alive) return;

    lobby.votes[socket.id] = targetId;

    // Check if all alive players have voted
    const alivePlayers = lobby.players.filter(p => p.alive);
    const voteCount = Object.keys(lobby.votes).length;

    io.to(lobby.code).emit('voteCast', {
      voterId: socket.id,
      targetId: targetId
    });

    if (voteCount === alivePlayers.length) {
      resolveVotes(lobby);
    }
  });

  // Night actions
  socket.on('nightAction', (targetId) => {
    const player = players[socket.id];
    if (!player || !lobbies[player.lobbyCode]) return;

    const lobby = lobbies[player.lobbyCode];
    const lobbyPlayer = lobby.players.find(p => p.id === socket.id);

    if (lobbyPlayer.role === 'mafia') {
      lobby.mafiaTarget = targetId;
    } else if (lobbyPlayer.role === 'doctor') {
      lobby.doctorTarget = targetId;
    } else if (lobbyPlayer.role === 'detective') {
      lobby.detectiveTarget = targetId;
      const target = lobby.players.find(p => p.id === targetId);
      io.to(socket.id).emit('detectiveResult', {
        targetId: targetId,
        isMafia: target.role === 'mafia'
      });
    }

    checkNightActionsComplete(lobby);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const player = players[socket.id];
    
    if (player && lobbies[player.lobbyCode]) {
      const lobby = lobbies[player.lobbyCode];
      lobby.players = lobby.players.filter(p => p.id !== socket.id);
      delete players[socket.id];
      
      io.to(lobby.code).emit('playerLeft', { playerId: socket.id });
      
      // If host left and there are still players, assign new host
      if (lobby.host === socket.id && lobby.players.length > 0) {
        lobby.host = lobby.players[0].id;
        io.to(lobby.code).emit('newHost', { hostId: lobby.host });
      }

      // If lobby is empty, delete it
      if (lobby.players.length === 0) {
        delete lobbies[lobby.code];
      }
    }
  });
});

function joinLobby(socket, username, lobbyCode) {
  const lobby = lobbies[lobbyCode];
  
  const player = {
    id: socket.id,
    username: username,
    lobbyCode: lobbyCode,
    role: null,
    alive: true,
    ready: false
  };

  players[socket.id] = player;
  lobby.players.push(player);

  socket.join(lobbyCode);

  // Send lobby state to the new player
  io.to(socket.id).emit('lobbyState', {
    lobby: lobby,
    playerId: socket.id
  });

  // Notify other players
  io.to(lobbyCode).emit('playerJoined', player);
}

function startGame(lobbyCode) {
  const lobby = lobbies[lobbyCode];
  if (!lobby) return;

  // Assign roles
  const shuffledRoles = shuffle([...ROLES]);
  const extraVillagers = Array(lobby.players.length - 4).fill('villager');
  const allRoles = shuffle([...shuffledRoles, ...extraVillagers]);

  lobby.players.forEach((player, index) => {
    player.role = allRoles[index];
    io.to(player.id).emit('gameStarted', { role: player.role });
  });

  // Start night phase
  lobby.phase = 'night';
  lobby.dayCount = 0;

  io.to(lobbyCode).emit('phaseChanged', { phase: 'night' });

  // Notify night roles
  const mafia = lobby.players.filter(p => p.role === 'mafia');
  mafia.forEach(m => {
    io.to(m.id).emit('nightPhase', {
      role: 'mafia',
      targets: lobby.players.filter(p => p.id !== m.id && p.alive)
    });
  });

  const doctor = lobby.players.find(p => p.role === 'doctor');
  if (doctor && doctor.alive) {
    io.to(doctor.id).emit('nightPhase', {
      role: 'doctor',
      targets: lobby.players.filter(p => p.id !== doctor.id && p.alive)
    });
  }

  const detective = lobby.players.find(p => p.role === 'detective');
  if (detective && detective.alive) {
    io.to(detective.id).emit('nightPhase', {
      role: 'detective',
      targets: lobby.players.filter(p => p.id !== detective.id && p.alive)
    });
  }
}

function checkNightActionsComplete(lobby) {
  const mafia = lobby.players.filter(p => p.role === 'mafia' && p.alive);
  const doctor = lobby.players.find(p => p.role === 'doctor' && p.alive);
  const detective = lobby.players.find(p => p.role === 'detective' && p.alive);

  const mafiaVoted = lobby.mafiaTarget !== null;
  const doctorVoted = lobby.doctorTarget !== null || !doctor;
  const detectiveVoted = lobby.detectiveTarget !== null || !detective;

  if (mafiaVoted && doctorVoted && detectiveVoted) {
    resolveNight(lobby);
  }
}

function resolveNight(lobby) {
  // Reset night actions
  const target = lobby.mafiaTarget;
  const saved = lobby.doctorTarget;
  
  let died = null;
  if (target && target !== saved) {
    const victim = lobby.players.find(p => p.id === target);
    if (victim) {
      victim.alive = false;
      died = victim;
    }
  }

  lobby.mafiaTarget = null;
  lobby.doctorTarget = null;
  lobby.detectiveTarget = null;

  // Check win conditions
  const mafiaCount = lobby.players.filter(p => p.role === 'mafia' && p.alive).length;
  const villageCount = lobby.players.filter(p => p.role !== 'mafia' && p.alive).length;

  if (mafiaCount === 0) {
    endGame(lobby, 'village');
    return;
  } else if (mafiaCount >= villageCount) {
    endGame(lobby, 'mafia');
    return;
  }

  // Start day phase
  lobby.phase = 'day';
  lobby.dayCount++;
  lobby.votes = {};

  io.to(lobby.code).emit('phaseChanged', { 
    phase: 'day',
    died: died ? { id: died.id, username: died.username } : null
  });

  // Check win conditions again
  checkWinCondition(lobby);
}

function resolveVotes(lobby) {
  const voteCounts = {};
  
  // Count votes
  Object.values(lobby.votes).forEach(targetId => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });

  // Find player with most votes
  let maxVotes = 0;
  let eliminated = null;
  
  Object.entries(voteCounts).forEach(([playerId, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      eliminated = playerId;
    }
  });

  // Eliminate player
  if (eliminated) {
    const player = lobby.players.find(p => p.id === eliminated);
    if (player) {
      player.alive = false;
      io.to(lobby.code).emit('playerEliminated', {
        playerId: eliminated,
        username: player.username,
        role: player.role
      });
    }
  }

  lobby.votes = {};

  // Check win conditions
  if (!checkWinCondition(lobby)) {
    // Start night phase
    lobby.phase = 'night';
    io.to(lobby.code).emit('phaseChanged', { phase: 'night' });

    // Notify night roles
    const mafia = lobby.players.filter(p => p.role === 'mafia' && p.alive);
    mafia.forEach(m => {
      io.to(m.id).emit('nightPhase', {
        role: 'mafia',
        targets: lobby.players.filter(p => p.id !== m.id && p.alive)
      });
    });

    const doctor = lobby.players.find(p => p.role === 'doctor' && p.alive);
    if (doctor) {
      io.to(doctor.id).emit('nightPhase', {
        role: 'doctor',
        targets: lobby.players.filter(p => p.id !== doctor.id && p.alive)
      });
    }

    const detective = lobby.players.find(p => p.role === 'detective' && p.alive);
    if (detective) {
      io.to(detective.id).emit('nightPhase', {
        role: 'detective',
        targets: lobby.players.filter(p => p.id !== detective.id && p.alive)
      });
    }
  }
}

function checkWinCondition(lobby) {
  const mafiaCount = lobby.players.filter(p => p.role === 'mafia' && p.alive).length;
  const villageCount = lobby.players.filter(p => p.role !== 'mafia' && p.alive).length;

  if (mafiaCount === 0) {
    endGame(lobby, 'village');
    return true;
  } else if (mafiaCount >= villageCount) {
    endGame(lobby, 'mafia');
    return true;
  }

  return false;
}

function endGame(lobby, winner) {
  lobby.phase = 'ended';
  
  io.to(lobby.code).emit('gameEnded', {
    winner: winner,
    players: lobby.players.map(p => ({
      username: p.username,
      role: p.role,
      alive: p.alive
    }))
  });
}

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Mafia.io server running on port ${PORT}`);
});
