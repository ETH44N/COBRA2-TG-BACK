# Telegram Multi-Account Backend Service

A robust backend service for managing multiple Telegram accounts and monitoring channels for new and deleted messages.

## Features

- **Multiple Telegram Account Management**: Handle multiple accounts with automatic failover
- **Channel Monitoring**: Track new and deleted messages in Telegram channels
- **Webhook System**: Trigger webhooks for message events with secure delivery
- **API Endpoints**: Comprehensive REST API for managing all aspects of the service
- **Reliability**: Automatic health checks, logging, and error recovery

## Installation

### Prerequisites

- Node.js 14+
- MongoDB 4.4+
- Telegram API credentials (API ID and Hash)

### Setup

1. Clone the repository:
   ```
   git clone https://github.com/yourusername/telegram-multi-account-service.git
   cd telegram-multi-account-service
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Copy the example environment file and configure it:
   ```
   cp .env.example .env
   ```
   Edit the `.env` file with your Telegram API credentials and other settings.

4. Start the service:
   ```
   npm start
   ```

### Docker Setup

Alternatively, you can use Docker Compose: 
```
docker-compose up -d
```

## Mass Channel Import and Monitoring

This service includes special scripts for importing and monitoring large numbers of Telegram channels while respecting rate limits to prevent account bans.

### Import Telegram Accounts

Before monitoring channels, you need to import Telegram accounts:

```
node scripts/import-accounts.js
```

This script will:
- Read accounts from COBRA.telegramAccounts.json
- Test each account's connection to Telegram
- Import valid accounts into the database

### Import Channels

To add channels from a text file (channels.txt):

```
node scripts/import-channels.js
```

Features:
- Rate-limited channel joining to prevent account bans
- Distributes channels evenly across accounts
- Logs results to channel-import-results.log
- Adds a conservative number of channels per day

### Monitor System Health

View the status of accounts, channels, and messages:

```
node scripts/monitor-status.js
```

This provides a comprehensive report including:
- Account statistics (active, banned, inactive)
- Channel statistics and distribution
- Message counts and history
- Assignments between accounts and channels

### Maintain Channel Assignments

Run the maintenance script to automatically check for banned accounts and reassign their channels:

```
node scripts/maintain-channels.js
```

Features:
- Periodic health checks of all accounts
- Automatic detection of banned accounts
- Reassignment of channels from banned accounts to healthy ones
- Handling of orphaned channels

## Production Best Practices

For production use, run the maintenance script continuously:

```
pm2 start scripts/maintain-channels.js --name "channel-maintenance"
```

Add channels in smaller batches over time to avoid triggering Telegram's anti-spam systems:

```
# Add 25 channels at a time
head -n 25 channels.txt > batch1.txt
node scripts/import-channels.js --file=batch1.txt

# Wait 24 hours before adding more
```

## API Endpoints

See the [API Documentation](DOCS/API.md) for details on the available endpoints. 