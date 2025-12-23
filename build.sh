#!/bin/bash
# Vercel Build Script for Node.js/Express API

echo "🚀 Starting Vercel build for voting-tool API..."

# Check Node.js version
echo "Node.js version: $(node --version)"
echo "NPM version: $(npm --version)"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Verify Express and dependencies
echo "✅ Verifying dependencies..."
npm list express cors firebase-admin nodemailer

# Build complete
echo "✅ Vercel build completed successfully!"
echo "🎯 API ready for deployment"