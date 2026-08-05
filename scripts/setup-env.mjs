#!/usr/bin/env node

/**
 * Setup script to create .env.local with all required environment variables.
 * Runs automatically via `npm run prepare` after install.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

const envLocalPath = path.join(process.cwd(), '.env.local');

// Check if .env.local already exists
if (fs.existsSync(envLocalPath)) {
  console.log('✓ .env.local already exists');
  process.exit(0);
}

// Generate a secure AUTH_SECRET
const authSecret = crypto.randomBytes(32).toString('hex');

// Create .env.local content
const envContent = `# Auto-generated environment configuration
# Generated: ${new Date().toISOString()}

# Authentication
AUTH_ENABLED=true
AUTH_SECRET=${authSecret}
DATABASE_URL=file:./data/spotter.db

# IBKR Gateway
IBKR_GATEWAY_URL=https://localhost:5001
`;

// Write .env.local
fs.writeFileSync(envLocalPath, envContent, 'utf-8');
console.log('✓ Created .env.local with full-features configuration');

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('• Created data directory');
}

// Run db:migrate if migrations haven't been run yet
const dbFile = path.join(dataDir, 'spotter.db');
if (!fs.existsSync(dbFile)) {
  console.log('• Running database migrations...');
  
  const migrate = spawn('npm', ['run', 'db:migrate'], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  migrate.on('close', (code) => {
    if (code === 0) {
      console.log('✓ Database initialized');
      console.log('\n🎉 Setup complete! Run `npm run dev` to start with all features enabled.');
    } else {
      console.error('✗ Database migration failed');
      process.exit(code);
    }
  });
} else {
  console.log('✓ Database already initialized');
  console.log('\n🎉 Setup complete! Run `npm run dev` to start with all features enabled.');
}
