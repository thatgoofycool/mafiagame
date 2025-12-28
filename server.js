const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from current directory
app.use(express.json());
app.use(express.static(__dirname));

// Store lobbies in memory
const lobbies = {};

// API: Get all public lobbies
app.get('/api/lobbies', (req, res) => {
  const publicLobbies = Object.values(lobbies)
    .filter(l => l.isPublic && Object.keys(l.players).length < l.maxPlayers)
    .map(l => ({
      id: l.id,
      name: l.name,
      players: Object.keys(l.players).length,
      maxPlayers: l.maxPlayers,
      isPublic: l.isPublic
    }));
  
  res.json(publicLobbies);
});

// API: Create a new lobby
app.post('/api/lobbies', (req, res) => {
  const { name, isPublic, maxPlayers } = req.body;
  
  // Generate a 4-character lobby code
  const generateCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  };
  
  let lobbyCode = generateCode();
  while (lobbies[lobbyCode]) {
    lobbyCode = generateCode();
  }
  
  lobbies[lobbyCode] = {
    id: lobbyCode,
    name: name || `Lobby ${lobbyCode}`,
    isPublic: isPublic !== false,
    maxPlayers: maxPlayers || 10,
    players: {},
    messages: [],
    gameStarted: false,
    phase: 'lobby', // lobby, day, night
    dayCount: 0,
    votes: {}
  };
  
  console.log(`Lobby created: ${lobbyCode}`);
  res.json({ lobbyId: lobbyCode, lobby: lobbies[lobbyCode] });
});

// API: Join a lobby
app.post('/api/lobbies/join', (req, res) => {
  const { lobbyId } = req.body;
  
  if (!lobbies[lobbyId]) {
    return res.status(404).json({ error: 'Lobby not found' });
  }
  
  if (lobbies[lobbyId].gameStarted) {
    return res.status(400).json({ error: 'Game already started' });
  }
  
  res.json({ lobby: lobbies[lobbyId] });
});

// Serve index.html for root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  
  let currentLobbyId = null;
  let currentNickname = null;
  
  // Join a lobby
  socket.on('join-lobby', ({ lobbyId, nickname }) => {
    currentLobbyId = lobbyId;
    currentNickname = nickname;
    
    if (!lobbies[lobbyId]) {
      socket.emit('error', { message: 'Lobby not found' });
      return;
    }
    
    const lobby = lobbies[lobbyId];
    socket.join(lobbyId);
    
    // Add player to lobby
    lobby.players[socket.id] = {
      id: socket.id,
      nickname: nickname,
      isReady: false,
      isAlive: true,
      role: null
    };
    
    // Notify everyone in the lobby
    io.to(lobbyId).emit('player-joined', lobby.players[socket.id]);
    io.to(lobbyId).emit('lobby-update', lobby);
    
    // Send lobby info to the joining player
    socket.emit('lobby-joined', lobby);
    
    console.log(`${nickname} joined lobby ${lobbyId}`);
  });
  
  // Toggle ready status
  socket.on('player-ready', () => {
    if (!currentLobbyId || !lobbies[currentLobbyId]) return;
    
    const lobby = lobbies[currentLobbyId];
    if (lobby.players[socket.id]) {
      lobby.players[socket.id].isReady = !lobby.players[socket.id].isReady;
      io.to(currentLobbyId).emit('player-ready', lobby.players[socket.id]);
      io.to(currentLobbyId).emit('lobby-update', lobby);
      
      // Check if all players are ready
      const allReady = Object.values(lobby.players).every(p => p.isReady);
      const minPlayers = 4;
      
      if (allReady && Object.keys(lobby.players).length >= minPlayers && !lobby.gameStarted) {
        startGame(currentLobbyId);
      }
    }
  });
  
  // Chat message
  socket.on('chat-message', ({ message, isMafiaOnly }) => {
    if (!currentLobbyId || !lobbies[currentLobbyId]) return;
    
    const lobby = lobbies[currentLobbyId];
    const player = lobby.players[socket.id];
    
    if (!player) return;
    
    const chatMessage = {
      id: Date.now(),
      playerId: socket.id,
      playerName: player.nickname,
      message: message,
      isMafiaOnly: isMafiaOnly,
      timestamp: new Date().toISOString()
    };
    
    lobby.messages.push(chatMessage);
    
    if (isMafiaOnly) {
      // Send only to mafia players
      Object.values(lobby.players).forEach(p => {
        if (p.role === 'Mafia') {
          io.to(p.id).emit('chat-message', chatMessage);
        }
      });
    } else {
      io.to(currentLobbyId).emit('chat-message', chatMessage);
    }
  });
  
  // Vote for elimination (day phase)
  socket.on('vote', ({ targetId }) => {
    if (!currentLobbyId || !lobbies[currentLobbyId]) return;
    
    const lobby = lobbies[currentLobbyId];
    const player = lobby.players[socket.id];
    
    if (!player || !player.isAlive || lobby.phase !== 'day') return;
    
    // Clear previous vote from this player
    for (const voterId in lobby.votes) {
      if (voterId === socket.id) {
        delete lobby.votes[voterId];
      }
    }
    
    // Add new vote
    lobby.votes[socket.id] = targetId;
    
    io.to(currentLobbyId).emit('vote-cast', { voterId: socket.id, targetId });
    io.to(currentLobbyId).emit('lobby-update', lobby);
    
    // Check if all alive players have voted
    const alivePlayers = Object.values(lobby.players).filter(p => p.isAlive);
    const voteCount = Object.keys(lobby.votes).length;
    
    if (voteCount >= alivePlayers.length) {
      // Count votes and eliminate player
      const voteCounts = {};
      Object.values(lobby.votes).forEach(targetId => {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
      });
      
      // Find player with most votes
      let maxVotes = 0;
      let eliminatedId = null;
      let tie = false;
      
      for (const [id, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) {
          maxVotes = count;
          eliminatedId = id;
          tie = false;
        } else if (count === maxVotes) {
          tie = true;
        }
      }
      
      if (!tie && eliminatedId) {
        lobby.players[eliminatedId].isAlive = false;
        io.to(currentLobbyId).emit('player-eliminated', lobby.players[eliminatedId]);
        
        // Check win condition
        if (checkWinCondition(currentLobbyId)) {
          return;
        }
      } else {
        io.to(currentLobbyId).emit('no-elimination');
      }
      
      // Clear votes and start night
      lobby.votes = {};
      startNight(currentLobbyId);
    }
  });
  
  // Doctor action (heal)
  socket.on('doctor-action', ({ targetId }) => {
    if (!currentLobbyId || !lobbies[currentLobbyId]) return;
    
    const lobby = lobbies[currentLobbyId];
    const player = lobby.players[socket.id];
    
    if (!player || player.role !== 'Doctor' || lobby.phase !== 'night') return;
    
    lobby.doctorTarget = targetId;
    io.to(socket.id).emit('action-complete', { message: 'You protected ' + lobby.players[targetId].nickname });
  });
  
  // Detective action (investigate)
  socket.on('detective-action', ({ targetId }) => {
    if (!currentLobbyId || !lobbies[currentLobbyId]) return;
    
    const lobby = lobbies[currentLobbyId];
    const player = lobby.players[socket.id];
    
    if (!player || player.role !== 'Detective' || lobby.phase !== 'night') return;
    
    const targetPlayer = lobby.players[targetId];
    const isMafia = targetPlayer.role === 'Mafia';
    
    io.to(socket.id).emit('investigation-result', {
      targetName: targetPlayer.nickname,
      isMafia: isMafia
    });
  });
  
  // Mafia action (kill)
  socket.on('mafia-action', ({ targetId }) => {
    if (!currentLobbyId || !lobbies[currentLobbyId]) return;
    
    const lobby = lobbies[currentLobbyId];
    const player = lobby.players[socket.id];
    
    if (!player || player.role !== 'Mafia' || lobby.phase !== 'night') return;
    
    lobby.mafiaTarget = targetId;
    io.to(currentLobbyId).emit('mafia-action-complete');
  });
  
  // Skip phase (for testing/debugging)
  socket.on('skip-phase', () => {
    if (!currentLobbyId || !lobbies[currentLobbyId]) return;
    
    const lobby = lobbies[currentLobbyId];
    
    if (lobby.phase === 'day') {
      lobby.votes = {};
      startNight(currentLobbyId);
    } else if (lobby.phase === 'night') {
      resolveNight(currentLobbyId);
    }
  });
  
  // Leave lobby
  socket.on('leave-lobby', () => {
    if (currentLobbyId && lobbies[currentLobbyId]) {
      const lobby = lobbies[currentLobbyId];
      delete lobby.players[socket.id];
      
      io.to(currentLobbyId).emit('player-left', { playerId: socket.id });
      io.to(currentLobbyId).emit('lobby-update', lobby);
      
      // Delete lobby if empty
      if (Object.keys(lobby.players).length === 0) {
        delete lobbies[currentLobbyId];
        console.log(`Lobby ${currentLobbyId} deleted (empty)`);
      }
    }
    
    socket.leave(currentLobbyId);
    currentLobbyId = null;
    currentNickname = null;
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    
    if (currentLobbyId && lobbies[currentLobbyId]) {
      const lobby = lobbies[currentLobbyId];
      delete lobby.players[socket.id];
      
      io.to(currentLobbyId).emit('player-left', { playerId: socket.id });
      io.to(currentLobbyId).emit('lobby-update', lobby);
      
      // Delete lobby if empty
      if (Object.keys(lobby.players).length === 0) {
        delete lobbies[currentLobbyId];
        console.log(`Lobby ${currentLobbyId} deleted (empty)`);
      }
    }
  });
});

// Start the game
function startGame(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby || lobby.gameStarted) return;
  
  lobby.gameStarted = true;
  lobby.phase = 'night';
  lobby.dayCount = 0;
  
  // Assign roles
  const playerIds = Object.keys(lobby.players);
  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  const numPlayers = playerIds.length;
  
  // Role distribution
  const numMafia = Math.floor(numPlayers / 4);
  const numDoctors = 1;
  const numDetectives = 1;
  const numVillagers = numPlayers - numMafia - numDoctors - numDetectives;
  
  let roles = [];
  for (let i = 0; i < numMafia; i++) roles.push('Mafia');
  for (let i = 0; i < numDoctors; i++) roles.push('Doctor');
  for (let i = 0; i < numDetectives; i++) roles.push('Detective');
  for (let i = 0; i < numVillagers; i++) roles.push('Villager');
  
  // Shuffle roles
  roles = roles.sort(() => Math.random() - 0.5);
  
  // Assign roles to players
  shuffled.forEach((playerId, index) => {
    lobby.players[playerId].role = roles[index];
    
    // Send role to player
    io.to(playerId).emit('game-started', {
      role: roles[index],
      players: lobby.players
    });
  });
  
  // Notify everyone night phase started
  io.to(lobbyId).emit('phase-change', { phase: 'night', dayCount: 0 });
  
  console.log(`Game started in lobby ${lobbyId}`);
}

// Start night phase
function startNight(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  
  lobby.phase = 'night';
  lobby.doctorTarget = null;
  lobby.mafiaTarget = null;
  
  io.to(lobbyId).emit('phase-change', { phase: 'night', dayCount: lobby.dayCount });
  
  // Auto-resolve night after 30 seconds if no action
  setTimeout(() => {
    if (lobby.phase === 'night') {
      resolveNight(lobbyId);
    }
  }, 30000);
}

// Resolve night phase
function resolveNight(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  
  // If mafia targeted someone and doctor didn't protect them, kill them
  if (lobby.mafiaTarget && lobby.mafiaTarget !== lobby.doctorTarget) {
    lobby.players[lobby.mafiaTarget].isAlive = false;
    io.to(lobbyId).emit('player-killed', lobby.players[lobby.mafiaTarget]);
  } else {
    io.to(lobbyId).emit('no-kill');
  }
  
  // Check win condition
  if (checkWinCondition(lobbyId)) {
    return;
  }
  
  // Start day
  startDay(lobbyId);
}

// Start day phase
function startDay(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;
  
  lobby.phase = 'day';
  lobby.dayCount++;
  lobby.votes = {};
  
  io.to(lobbyId).emit('phase-change', { phase: 'day', dayCount: lobby.dayCount });
}

// Check win condition
function checkWinCondition(lobbyId) {
  const lobby = lobbies[lobbyId];
  if (!lobby) return false;
  
  const alivePlayers = Object.values(lobby.players).filter(p => p.isAlive);
  const aliveMafia = alivePlayers.filter(p => p.role === 'Mafia').length;
  const aliveVillagers = alivePlayers.filter(p => p.role !== 'Mafia').length;
  
  if (aliveMafia === 0) {
    io.to(lobbyId).emit('game-over', { winner: 'Villagers' });
    return true;
  }
  
  if (aliveMafia >= aliveVillagers) {
    io.to(lobbyId).emit('game-over', { winner: 'Mafia' });
    return true;
  }
  
  return false;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Mafia.io server running on port ${PORT}`);
});
