# Mafia.io - Online Multiplayer

A real-time multiplayer Mafia game with lobbies, chat, and live gameplay.

## Quick Start (Local)

1. **Install Node.js** (version 16 or higher) from https://nodejs.org/

2. **Open a terminal/command prompt** in the project folder

3. **Install dependencies:**
   ```bash
   npm install
   ```

4. **Start the server:**
   ```bash
   npm start
   ```

5. **Open your browser** and go to:
   ```
   http://localhost:3000
   ```

6. **Open multiple browser tabs** to test with multiple players!

---

## Hosting Options

### Option 1: Railway (Easiest, Free Tier)

1. Go to https://railway.app/ and create an account
2. Click "New Project" → "Deploy from GitHub"
3. Push your code to GitHub first, or use "Deploy from CLI"
4. Railway will automatically detect Node.js and deploy
5. Your game will be live at: `https://your-project.railway.app`

### Option 2: Render (Free Tier Available)

1. Go to https://render.com/ and create an account
2. Click "New" → "Web Service"
3. Connect your GitHub repository
4. Set:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Deploy! Your game will be at: `https://your-project.onrender.com`

### Option 3: Heroku (Free Trial)

1. Install Heroku CLI: https://devcenter.heroku.com/articles/heroku-cli
2. Login: `heroku login`
3. Create app: `heroku create`
4. Deploy: `git push heroku main`

### Option 4: VPS (Your Own Server)

Requirements: Any VPS with Node.js (DigitalOcean, Linode, AWS, etc.)

1. **Connect to your server:**
   ```bash
   ssh user@your-server-ip
   ```

2. **Install Node.js:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

3. **Upload your files** (using SCP or Git)

4. **Install dependencies:**
   ```bash
   cd /path/to/mafia-io
   npm install
   ```

5. **Start with PM2 (recommended for production):**
   ```bash
   npm install -g pm2
   pm2 start server.js --name mafia-io
   pm2 startup
   pm2 save
   ```

6. **Setup reverse proxy with Nginx:**
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;
       
       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

---

## File Structure

```
mafia-io/
├── package.json          # Dependencies and scripts
├── server.js             # Node.js backend server
├── public/
│   └── index.html        # Frontend game (single file)
└── README.md            # This file
```

---

## Game Roles

| Role | Team | Ability |
|------|------|---------|
| Mafia | Evil | Kill one player each night |
| Doctor | Good | Protect one player each night |
| Detective | Good | Investigate one player per night |
| Villager | Good | Vote to eliminate mafia |

---

## How to Play

1. **Join or create a lobby**
2. **Wait for all players to ready up**
3. **Host starts the game**
4. **Roles are assigned secretly**
5. **Night Phase:** Mafia, Doctor, and Detective perform actions
6. **Day Phase:** Discuss and vote to eliminate suspects
7. **Win Condition:** Mafia wins if they equal/outnumber townspeople. Town wins if all mafia are eliminated.

---

## Environment Variables (Optional)

Create a `.env` file in the project root:

```env
PORT=3000
NODE_ENV=production
```

---

## Troubleshooting

**Server won't start?**
- Make sure Node.js is installed: `node --version`
- Delete `node_modules` and run `npm install` again

**Can't connect from other devices?**
- Make sure your firewall allows port 3000
- Use your local IP address instead of localhost: `http://YOUR_IP:3000`

**Socket.io connection issues?**
- Check that the frontend is connecting to the correct server URL
- Ensure CORS is properly configured in server.js

---

## License

Feel free to use and modify for your own projects!
