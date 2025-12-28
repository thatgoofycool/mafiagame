const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Game state
const lobbies = new Map();
const players = new Map();

// Utility functions
function generateLobbyCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function assignRoles(lobby) {
  const playerIds = Object.keys(lobby.players);
  const numPlayers = playerIds.length;
  const numMafia = Math.floor(numPlayers / 3);
  const roles = [];
  
  // Add mafia
  for (let i = 0; i < numMafia; i++) {
    roles.push('mafia');
  }
  // Add doctor and detective
  roles.push('doctor');
  roles.push('detective');
  // Rest are villagers
  while (roles.length < numPlayers) {
    roles.push('villager');
  }
  
  // Shuffle roles
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  
  // Assign roles to players
  playerIds.forEach((id, index) => {
    lobby.players[id].role = roles[index];
    lobby.players[id].alive = true;
    lobby.players[id].votes = 0;
  });
  
  return lobby;
}

function checkWinCondition(lobby) {
  const alivePlayers = Object.values(lobby.players).filter(p => p.alive);
  const aliveMafia = alivePlayers.filter(p => p.role === 'mafia').length;
  const aliveVillagers = alivePlayers.filter(p => p.role !== 'mafia').length;
  
  if (aliveMafia === 0) {
    return 'town';
  } else if (aliveMafia >= aliveVillagers) {
    return 'mafia';
  }
  return null;
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  
  // Create lobby
  socket.on('createLobby', ({ name, maxPlayers }) => {
    const lobbyCode = generateLobbyCode();
    const lobby = {
      code: lobbyCode,
      host: socket.id,
      name: name,
      maxPlayers: maxPlayers || 10,
      players: {},
      phase: 'waiting',
      dayCount: 0,
      votes: {},
      nightActions: {},
      mafiaTarget: null,
      doctorTarget: null,
      started: false
    };
    
    lobby.players[socket.id] = {
      id: socket.id,
      name: name,
      ready: true,
      role: null,
      alive: true
    };
    
    lobbies.set(lobbyCode, lobby);
    socket.join(lobbyCode);
    socket.emit('lobbyCreated', lobby);
    io.to(lobbyCode).emit('lobbyUpdate', lobby);
    
    console.log(`Lobby created: ${lobbyCode}`);
  });
  
  // Join lobby
  socket.on('joinLobby', ({ name, code }) => {
    const lobby = lobbies.get(code.toUpperCase());
    
    if (!lobby) {
      socket.emit('error', 'Lobby not found');
      return;
    }
    
    if (Object.keys(lobby.players).length >= lobby.maxPlayers) {
      socket.emit('error', 'Lobby is full');
      return;
    }
    
    lobby.players[socket.id] = {
      id: socket.id,
      name: name,
      ready: false,
      role: null,
      alive: true
    };
    
    socket.join(code);
    socket.emit('joinedLobby', lobby);
    io.to(code).emit('lobbyUpdate', lobby);
    
    // Join message
    io.to(code).emit('chatMessage', {
      type: 'system',
      message: `${name} joined the lobby`
    });
  });
  
  // Ready up
  socket.on('toggleReady', () => {
    let lobby = null;
    let lobbyCode = null;
    
    lobbies.forEach((l, code) => {
      if (l.players[socket.id]) {
        lobby = l;
        lobbyCode = code;
      }
    });
    
    if (lobby && !lobby.started) {
      lobby.players[socket.id].ready = !lobby.players[socket.id].ready;
      io.to(lobbyCode).emit('lobbyUpdate', lobby);
    }
  });
  
  // Start game
  socket.on('startGame', () => {
    let lobby = null;
    let lobbyCode = null;
    
    lobbies.forEach((l, code) => {
      if (l.host === socket.id) {
        lobby = l;
        lobbyCode = code;
      }
    });
    
    if (lobby && lobby.host === socket.id && !lobby.started) {
      // Check if all players are ready
      const allReady = Object.values(lobby.players).every(p => p.ready);
      if (Object.keys(lobby.players).length >= 3 && allReady) {
        assignRoles(lobby);
        lobby.started = true;
        lobby.phase = 'night';
        lobby.dayCount = 1;
        lobby.nightActions = {};
        
        io.to(lobbyCode).emit('gameStarted', lobby);
        
        // Send individual role info
        Object.keys(lobby.players).forEach(id => {
          const player = lobby.players[id];
          io.to(id).emit('roleReveal', {
            role: player.role,
            players: lobby.players
          });
        });
        
        // Start night phase
        setTimeout(() => {
          io.to(lobbyCode).emit('phaseChange', { phase: 'night', dayCount: lobby.dayCount });
        }, 2000);
      }
    }
  });
  
  // Night actions
  socket.on('nightAction', ({ targetId, action }) => {
    let lobby = null;
    let lobbyCode = null;
    
    lobbies.forEach((l, code) => {
      if (l.players[socket.id]) {
        lobby = l;
        lobbyCode = code;
      }
    });
    
    if (lobby && lobby.phase === 'night') {
      const player = lobby.players[socket.id];
      
      if (action === 'kill' && player.role === 'mafia' && player.alive) {
        lobby.mafiaTarget = targetId;
      } else if (action === 'heal' && player.role === 'doctor' && player.alive) {
        lobby.doctorTarget = targetId;
      } else if (action === 'investigate' && player.role === 'detective' && player.alive) {
        const target = lobby.players[targetId];
        const isMafia = target.role === 'mafia';
        io.to(socket.id).emit('investigationResult', { targetId, isMafia });
      }
      
      // Check if all night actions are done
      const alivePlayers = Object.values(lobby.players).filter(p => p.alive);
      const aliveMafia = alivePlayers.filter(p => p.role === 'mafia');
      const aliveDoctor = alivePlayers.find(p => p.role === 'doctor');
      const aliveDetective = alivePlayers.find(p => p.role === 'detective');
      
      let actionsComplete = lobby.mafiaTarget !== null;
      if (aliveDoctor) actionsComplete = actionsComplete && lobby.doctorTarget !== null;
      
      if (actionsComplete) {
        // Resolve night
        setTimeout(() => {
          let deaths = [];
          
          if (lobby.mafiaTarget && lobby.mafiaTarget !== lobby.doctorTarget) {
            const victim = lobby.players[lobby.mafiaTarget];
            if (victim) {
              victim.alive = false;
              deaths.push(victim.name);
            }
          }
          
          // Reset night actions
          lobby.mafiaTarget = null;
          lobby.doctorTarget = null;
          
          // Change to day phase
          lobby.phase = 'day';
          lobby.votes = {};
          
          io.to(lobbyCode).emit('nightResult', { deaths });
          io.to(lobbyCode).emit('phaseChange', { phase: 'day', dayCount: lobby.dayCount });
          io.to(lobbyCode).emit('lobbyUpdate', lobby);
          
          // Check win condition
          const winner = checkWinCondition(lobby);
          if (winner) {
            io.to(lobbyCode).emit('gameOver', { winner, players: lobby.players });
          }
        }, 1000);
      }
    }
  });
  
  // Vote during day
  socket.on('vote', ({ targetId }) => {
    let lobby = null;
    let lobbyCode = null;
    
    lobbies.forEach((l, code) => {
      if (l.players[socket.id]) {
        lobby = l;
        lobbyCode = code;
      }
    });
    
    if (lobby && lobby.phase === 'day' && lobby.players[socket.id].alive) {
      lobby.votes[socket.id] = targetId;
      
      // Count votes
      const voteCounts = {};
      Object.values(lobby.votes).forEach(target => {
        voteCounts[target] = (voteCounts[target] || 0) + 1;
      });
      
      const alivePlayers = Object.values(lobby.players).filter(p => p.alive);
      const totalVotes = Object.keys(lobby.votes).length;
      
      io.to(lobbyCode).emit('voteUpdate', { votes: lobby.votes, voteCounts });
      
      // Check if all players voted
      if (totalVotes >= alivePlayers.length) {
        // Find player with most votes
        let maxVotes = 0;
        let eliminated = null;
        let tie = false;
        
        Object.entries(voteCounts).forEach(([id, count]) => {
          if (count > maxVotes) {
            maxVotes = count;
            eliminated = id;
            tie = false;
          } else if (count === maxVotes) {
            tie = true;
          }
        });
        
        if (eliminated && !tie) {
          lobby.players[eliminated].alive = false;
          io.to(lobbyCode).emit('playerEliminated', { 
            player: lobby.players[eliminated].name,
            role: lobby.players[eliminated].role
          });
        } else {
          io.to(lobbyCode).emit('noElimination');
        }
        
        // Check win condition
        const winner = checkWinCondition(lobby);
        if (winner) {
          io.to(lobbyCode).emit('gameOver', { winner, players: lobby.players });
          return;
        }
        
        // Move to night
        setTimeout(() => {
          lobby.phase = 'night';
          lobby.dayCount++;
          lobby.votes = {};
          lobby.mafiaTarget = null;
          lobby.doctorTarget = null;
          
          io.to(lobbyCode).emit('phaseChange', { phase: 'night', dayCount: lobby.dayCount });
          io.to(lobbyCode).emit('lobbyUpdate', lobby);
        }, 3000);
      }
    }
  });
  
  // Skip vote
  socket.on('skipVote', () => {
    let lobby = null;
    let lobbyCode = null;
    
    lobbies.forEach((l, code) => {
      if (l.players[socket.id]) {
        lobby = l;
        lobbyCode = code;
      }
    });
    
    if (lobby && lobby.phase === 'day' && lobby.players[socket.id].alive) {
      lobby.votes[socket.id] = null;
      
      const voteCounts = {};
      Object.values(lobby.votes).forEach(target => {
        if (target) {
          voteCounts[target] = (voteCounts[target] || 0) + 1;
        }
      });
      
      const alivePlayers = Object.values(lobby.players).filter(p => p.alive);
      const totalVotes = Object.keys(lobby.votes).length;
      
      io.to(lobbyCode).emit('voteUpdate', { votes: lobby.votes, voteCounts });
      
      if (totalVotes >= alivePlayers.length) {
        setTimeout(() => {
          lobby.phase = 'night';
          lobby.dayCount++;
          lobby.votes = {};
          lobby.mafiaTarget = null;
          lobby.doctorTarget = null;
          
          io.to(lobbyCode).emit('phaseChange', { phase: 'night', dayCount: lobby.dayCount });
          io.to(lobbyCode).emit('lobbyUpdate', lobby);
        }, 3000);
      }
    }
  });
  
  // Chat messages
  socket.on('chatMessage', ({ message }) => {
    let lobby = null;
    let lobbyCode = null;
    
    lobbies.forEach((l, code) => {
      if (l.players[socket.id]) {
        lobby = l;
        lobbyCode = code;
      }
    });
    
    if (lobby) {
      const player = lobby.players[socket.id];
      
      // Mafia can chat with other mafia at night
      if (lobby.phase === 'night' && player.role === 'mafia') {
        io.to(lobbyCode).emit('chatMessage', {
          type: 'mafia',
          name: player.name,
          message: message
        });
      } 
      // Everyone can chat during day
      else if (lobby.phase === 'day') {
        io.to(lobbyCode).emit('chatMessage', {
          type: 'public',
          name: player.name,
          message: message
        });
      }
    }
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    
    let removedLobbyCode = null;
    
    lobbies.forEach((lobby, code) => {
      if (lobby.players[socket.id]) {
        const playerName = lobby.players[socket.id].name;
        delete lobby.players[socket.id];
        
        io.to(code).emit('chatMessage', {
          type: 'system',
          message: `${playerName} left the lobby`
        });
        
        io.to(code).emit('lobbyUpdate', lobby);
        
        // If host left, transfer to next player
        if (lobby.host === socket.id && Object.keys(lobby.players).length > 0) {
          const newHost = Object.keys(lobby.players)[0];
          lobby.host = newHost;
          io.to(code).emit('hostChange', { newHost: lobby.players[newHost].name });
          io.to(code).emit('lobbyUpdate', lobby);
        }
        
        // Remove empty lobbies
        if (Object.keys(lobby.players).length === 0) {
          removedLobbyCode = code;
        }
      }
    });
    
    if (removedLobbyCode) {
      lobbies.delete(removedLobbyCode);
      console.log(`Lobby removed: ${removedLobbyCode}`);
    }
  });
});

// Get public lobbies
app.get('/api/lobbies', (req, res) => {
  const publicLobbies = [];
  lobbies.forEach((lobby, code) => {
    if (!lobby.started && Object.keys(lobby.players).length < lobby.maxPlayers) {
      publicLobbies.push({
        code: code,
        name: lobby.name,
        players: Object.keys(lobby.players).length,
        maxPlayers: lobby.maxPlayers
      });
    }
  });
  res.json(publicLobbies);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mafia.io server running on port ${PORT}`);
});
