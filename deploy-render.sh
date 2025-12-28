#!/bin/bash

# Render deployment script for Mafia.io

echo "🎮 Preparing Mafia.io for Render deployment..."

# Check if repository is initialized
if [ ! -d ".git" ]; then
    echo "📦 Initializing Git repository..."
    git init
    git add .
    git commit -m "Initial commit: Mafia.io game"
    
    echo "📤 Push your code to GitHub, then deploy on Render.com"
    echo "1. Go to https://render.com"
    echo "2. Click 'New' → 'Web Service'"
    echo "3. Connect your GitHub repository"
    echo "4. Configure:"
    echo "   - Build Command: npm install"
    echo "   - Start Command: npm start"
    echo ""
    echo "That's it! Render will auto-deploy on every push."
else
    echo "✓ Git repository already exists"
    echo "💡 To deploy:"
    echo "1. Push your code to GitHub"
    echo "2. Create a new Web Service on render.com"
    echo "3. Connect your repository"
    echo "4. Set Build: npm install"
    echo "5. Set Start: npm start"
fi

echo ""
echo "📖 Full guide: https://render.com/docs/deploy-node-express-app"
