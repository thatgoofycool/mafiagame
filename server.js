const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Use PORT environment variable if available (for Railway), otherwise 3000
const PORT = process.env.PORT || 3000;

// Serve static files from current directory
app.use(express.static(path.join(__dirname)));

// Parse JSON bodies
app.use(express.json());

// In-memory lobby storage
const lobbies = new Map();

// API Routes

// Get all public lobbies
app.get('/api/lobbies', (req, res) => {
  const publicLobbies = [];
  for (const [code, lobby] of lobbies) {
    publicLobbies.push({
      code: code,
      name: lobby.name,
      players: lobby.players.length,
      maxPlayers: lobby.maxPlayers,
      status: lobby.status
    });
  }
  res.json(publicLobbies);
});

// Create a new lobby
app.post('/api/lobbies', (req, res) => {
  const { name, maxPlayers, creatorId, creatorName } = req.body;
  
  // Generate a 4-character lobby code
  const code = generateLobbyCode();
  
  const lobby = {
    code,
    name,
    maxPlayers: maxPlayers || 10,
    players: [],
    status: 'waiting',
    votes: {},
    nightActions: {},
    doctorProtected: null,
    mafiaTarget: null,
    detectiveResult: null,
    dayCount: 0,
    messages: []
  };
  
  lobbies.set(code, lobby);
  
  // Add creator as first player
  const player = {
    id: creatorId,
    name: creatorName,
    role: null,
    alive: true,
    isReady: false
  };
  lobby.players.push(player);
  
  res.json({ code, player });
});

// Join a lobby
app.post('/api/lobbies/join', (req, res) => {
  const { code, playerId, playerName } = req.body;
  
  const lobby = lobbies.get(code);
  
  if (!lobby) {
    return res.status(404).json({ error: 'Lobby not found' });
  }
  
  if (lobby.players.length >= lobby.maxPlayers) {
    return res.status(400).json({ error: 'Lobby is full' });
  }
  
  const player = {
    id: playerId,
    name: playerName,
    role: null,
    alive: true,
    isReady: false
  };
  
  lobby.players.push(player);
  
  res.json({ player });
});

// Serve index.html for root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Generate random 4-character code
function generateLobbyCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  // Ensure code is unique
  if (lobbies.has(code)) {
    return generateLobbyCode();
  }
  
  return code;
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Join lobby
  socket.on('joinLobby', ({ code, player }) => {
    const lobby = lobbies.get(code);
    if (lobby) {
      socket.join(code);
      io.to(code).emit('playerJoined', lobby.players);
      
      // Send existing messages
      if (lobby.messages.length > 0) {
        socket.emit('existingMessages', lobby.messages);
      }
    }
  });
  
  // Player ready
  socket.on('playerReady', ({ code, playerId }) => {
    const lobby = lobbies.get(code);
    if (lobby) {
      const player = lobby.players.find(p => p.id === playerId);
      if (player) {
        player.isReady = true;
        io.to(code).emit('playerUpdated', lobby.players);
        
        // Check if all players are ready
        if (lobby.players.every(p => p.isReady) && lobby.players.length >= 3) {
          startGame(code);
        }
      }
    }
  });
  
  // Start game
  socket.on('startGame', (code) => {
    startGame(code);
  });
  
  // Vote
  socket.on('vote', ({ code, playerId, targetId }) => {
    const lobby = lobbies.get(code);
    if (lobby && lobby.status === 'day') {
      lobby.votes[playerId] = targetId;
      
      // Check if all alive players have voted
      const alivePlayers = lobby.players.filter(p => p.alive);
      const votesCast = Object.keys(lobby.votes).length;
      
      if (votesCast >= alivePlayers.length) {
        // Count votes
        const voteCounts = {};
        for (const voterId in lobby.votes) {
          const targetId = lobby.votes[voterId];
          if (targetId) {
            voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
          }
        }
        
        // Find player with most votes
        let maxVotes = 0;
        let eliminated = null;
        for (const [playerId, count] of Object.entries(voteCounts)) {
          if (count > maxVotes) {
            maxVotes = count;
            eliminated = playerId;
          }
        }
        
        if (eliminated) {
          const player = lobby.players.find(p => p.id === eliminated);
          if (player) {
            player.alive = false;
            lobby.messages.push({
              type: 'system',
              content: `${player.name} was eliminated by the vote!`,
              timestamp: Date.now()
            });
          }
        } else {
          lobby.messages.push({
            type: 'system',
            content: 'No one was eliminated.',
            timestamp: Date.now()
          });
        }
        
        lobby.votes = {};
        
        // Check win conditions
        if (checkWinCondition(code)) {
          io.to(code).emit('gameOver', { winner: getWinner(lobby), players: lobby.players });
        } else {
          // Start night phase
          startNight(code);
        }
        
        io.to(code).emit('playersUpdated', lobby.players);
      }
    }
  });
  
  // Night actions
  socket.on('nightAction', ({ code, playerId, action, targetId }) => {
    const lobby = lobbies.get(code);
    if (lobby && lobby.status === 'night') {
      const player = lobby.players.find(p => p.id === playerId);
      
      if (player.role === 'mafia') {
        lobby.mafiaTarget = targetId;
      } else if (player.role === 'doctor') {
        lobby.doctorProtected = targetId;
      } else if (player.role === 'detective') {
        const target = lobby.players.find(p => p.id === targetId);
        if (target) {
          lobby.detectiveResult = {
            target: target.name,
            isMafia: target.role === 'mafia'
          };
          socket.emit('detectiveResult', lobby.detectiveResult);
        }
      }
      
      // Check if all night actions are done
      const mafiaPlayers = lobby.players.filter(p => p.role === 'mafia' && p.alive);
      const doctorPlayers = lobby.players.filter(p => p.role === 'doctor' && p.alive);
      const detectivePlayers = lobby.players.filter(p => p.role === 'detective' && p.alive);
      
      const mafiaDone = mafiaPlayers.length > 0 && lobby.mafiaTarget !== null;
      const doctorDone = doctorPlayers.length === 0 || lobby.doctorProtected !== null;
      const detectiveDone = detectivePlayers.length === 0 || lobby.detectiveResult !== null;
      
      if (mafiaDone && doctorDone && detectiveDone) {
        resolveNight(code);
      }
    }
  });
  
  // Chat messages
  socket.on('chatMessage', ({ code, playerId, message, isPrivate }) => {
    const lobby = lobbies.get(code);
    if (lobby) {
      const player = lobby.players.find(p => p.id === playerId);
      if (player && player.alive) {
        const msg = {
          type: isPrivate ? 'private' : 'chat',
          sender: player.name,
          content: message,
          timestamp: Date.now()
        };
        lobby.messages.push(msg);
        
        if (isPrivate) {
          // Send only to mafia members
          const mafiaPlayers = lobby.players.filter(p => p.role === 'mafia');
          mafiaPlayers.forEach(mafiaPlayer => {
            const mafiaSocket = Array.from(io.sockets.sockets.values()).find(s => {
              // This is simplified - in production, track socket.id with player
              return true;
            });
          });
          // For now, send to everyone in room (this will be improved)
          io.to(code).emit('newMessage', msg);
        } else {
          io.to(code).emit('newMessage', msg);
        }
      }
    }
  });
  
  // Leave lobby
  socket.on('leaveLobby', ({ code, playerId }) => {
    const lobby = lobbies.get(code);
    if (lobby) {
      const playerIndex = lobby.players.findIndex(p => p.id === playerId);
      if (playerIndex !== -1) {
        lobby.players.splice(playerIndex, 1);
        io.to(code).emit('playerLeft', lobby.players);
        
        // If lobby is empty, delete it
        if (lobby.players.length === 0) {
          lobbies.delete(code);
        }
      }
      socket.leave(code);
    }
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Handle cleanup if needed
  });
});

function startGame(code) {
  const lobby = lobbies.get(code);
  if (!lobby) return;
  
  // Assign roles
  const playerCount = lobby.players.length;
  const roles = [];
  
  // Determine role distribution based on player count
  if (playerCount >= 5) {
    roles.push('mafia', 'mafia', 'doctor', 'detective');
  } else if (playerCount >= 3) {
    roles.push('mafia', 'doctor', 'detective');
  }
  
  // Fill rest with villagers
  while (roles.length < playerCount) {
    roles.push('villager');
  }
  
  // Shuffle roles
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  
  // Assign to players
  lobby.players.forEach((player, index) => {
    player.role = roles[index];
  });
  
  lobby.status = 'night';
  lobby.dayCount = 0;
  
  // Send roles to players
  lobby.players.forEach(player => {
    io.to(code).emit('playerRole', { playerId: player.id, role: player.role });
  });
  
  io.to(code).emit('gameStarted', { players: lobby.players, phase: 'night' });
}

function startNight(code) {
  const lobby = lobbies.get(code);
  if (!lobby) return;
  
  lobby.status = 'night';
  lobby.mafiaTarget = null;
  lobby.doctorProtected = null;
  lobby.detectiveResult = null;
  
  io.to(code).emit('phaseChanged', 'night');
}

function resolveNight(code) {
  const lobby = lobbies.get(code);
  if (!lobby) return;
  
  // Process night actions
  if (lobby.mafiaTarget && lobby.mafiaTarget !== lobby.doctorProtected) {
    const target = lobby.players.find(p => p.id === lobby.mafiaTarget);
    if (target) {
      target.alive = false;
      lobby.messages.push({
        type: 'system',
        content: `${target.name} was killed during the night!`,
        timestamp: Date.now()
      });
    }
  } else if (lobby.mafiaTarget) {
    lobby.messages.push({
      type: 'system',
      content: 'No one died last night!',
      timestamp: Date.now()
    });
  }
  
  // Check win conditions
  if (checkWinCondition(code)) {
    io.to(code).emit('gameOver', { winner: getWinner(lobby), players: lobby.players });
  } else {
    // Start day phase
    lobby.status = 'day';
    lobby.dayCount++;
    lobby.votes = {};
    
    io.to(code).emit('phaseChanged', 'day');
    io.to(code).emit('playersUpdated', lobby.players);
  }
}

function checkWinCondition(code) {
  const lobby = lobbies.get(code);
  if (!lobby) return false;
  
  const mafiaAlive = lobby.players.filter(p => p.role === 'mafia' && p.alive).length;
  const townAlive = lobby.players.filter(p => p.role !== 'mafia' && p.alive).length;
  
  return mafiaAlive === 0 || mafiaAlive >= townAlive;
}

function getWinner(lobby) {
  const mafiaAlive = lobby.players.filter(p => p.role === 'mafia' && p.alive).length;
  return mafiaAlive === 0 ? 'town' : 'mafia';
}

server.listen(PORT, () => {
  console.log(`Mafia.io server running on port ${PORT}`);
});
