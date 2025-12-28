#!/bin/bash

# Railway deployment script for Mafia.io

echo "🎮 Deploying Mafia.io to Railway..."

# Check if Railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "📦 Installing Railway CLI..."
    npm install -g @railway/cli
fi

# Login to Railway
echo "🔐 Logging in to Railway..."
railway login

# Initialize Railway project
echo "🚀 Initializing Railway project..."
railway init

# Add PostgreSQL (optional, for future features)
echo "📊 Adding PostgreSQL database..."
railway add postgresql

# Deploy
echo "🚢 Deploying to Railway..."
railway up

echo "✅ Deployment complete!"
echo "🌐 Your game is now live at:"
railway domain
