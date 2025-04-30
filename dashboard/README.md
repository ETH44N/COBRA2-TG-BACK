# Telegram Monitor Dashboard

A web-based dashboard for monitoring Telegram accounts, channels, and messages.

## Features

- Account status monitoring and management
- Channel tracking and statistics
- Message history and deletion tracking
- Real-time statistics and charts

## Installation

### Prerequisites

- Node.js 14+ installed
- MongoDB running and accessible
- Main Telegram monitoring service set up with data in the database

### Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Make sure the `.env` file in the project root directory is configured correctly, particularly:
   ```
   MONGODB_URI=mongodb://localhost:27017/telegram-monitor
   DASHBOARD_PORT=3000
   ```

3. Start the dashboard server:
   ```
   npm start
   ```

   For development with auto-restart:
   ```
   npm run dev
   ```

4. Access the dashboard at http://localhost:3000

## Dashboard Pages

- **Home** (`/`): Overview of system status with account, channel, and message statistics
- **Accounts** (`/accounts`): List of all Telegram accounts with filtering and sorting options
- **Account Detail** (`/accounts/:id`): Detailed view of a specific account and its assigned channels
- **Channels** (`/channels`): List of all monitored channels with filtering and sorting options
- **Channel Detail** (`/channels/:id`): Detailed view of a specific channel with message history

## Running in Production

For production deployment, consider:

1. Using a process manager like PM2:
   ```
   npm install -g pm2
   pm2 start index.js --name "telegram-dashboard"
   ```

2. Setting up a reverse proxy with Nginx or Apache

3. Configuring appropriate security measures (HTTPS, authentication) 