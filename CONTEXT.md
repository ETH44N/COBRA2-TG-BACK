# Telegram Multi-Account Backend Service

## Overview

This backend service manages **multiple Telegram accounts** simultaneously and monitors **Telegram channels** for:

- **New messages**
- **Deleted messages**

The system logs all activity to a **database**, triggers **webhooks** on events, and provides:

- **Dynamic channel monitoring**
- **Health checks**
- **Logging and alerting** for reliability

## Features

### 1. Telegram Account Management

- Support for **multiple Telegram accounts** (session-based authentication)
- Track account metadata: phone number, username, session string, status (active/banned)
- Automatically reassign monitoring duties if an account is banned

### 2. Channel Monitoring

- Add channels to be monitored dynamically via API
- Detect and prevent duplicate joins if a channel is already monitored
- Listen for:
  - **New messages**
  - **Deleted messages**
- Persist channel history in database

### 3. Event Triggers (Webhooks)

- For every message create/delete event:
  - Save event to database
  - Send payload to a **configurable webhook endpoint**

### 4. Database Schema

#### Accounts Table
| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `username` | VARCHAR(255) | Telegram username |
| `phone_number` | VARCHAR(20) | Account phone number |
| `session_string` | TEXT | Telegram session authentication string |
| `status` | ENUM | 'active', 'banned', 'limited', 'inactive' |
| `last_active` | TIMESTAMP | Last activity timestamp |
| `created_at` | TIMESTAMP | Account creation timestamp |
| `updated_at` | TIMESTAMP | Last update timestamp |
| `max_channels` | INTEGER | Maximum channels this account can monitor |
| `current_channels_count` | INTEGER | Current number of channels being monitored |

#### Channels Table
| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `channel_id` | VARCHAR(255) | Telegram channel ID |
| `name` | VARCHAR(255) | Channel name |
| `username` | VARCHAR(255) | Channel username (if available) |
| `joined_by_account_id` | UUID | Foreign key to Accounts table |
| `date_joined` | TIMESTAMP | When the account joined this channel |
| `is_active` | BOOLEAN | Whether monitoring is active |
| `last_message_at` | TIMESTAMP | Last message timestamp |
| `created_at` | TIMESTAMP | Record creation timestamp |
| `updated_at` | TIMESTAMP | Last update timestamp |
| `description` | TEXT | Channel description |
| `member_count` | INTEGER | Approximate member count (if available) |

#### Messages Table
| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `channel_id` | UUID | Foreign key to Channels table |
| `telegram_message_id` | BIGINT | Original Telegram message ID |
| `content` | TEXT | Message content |
| `date_sent` | TIMESTAMP | When message was sent |
| `sender_id` | VARCHAR(255) | Sender's Telegram ID |
| `sender_name` | VARCHAR(255) | Sender's name |
| `is_deleted` | BOOLEAN | Whether message was deleted |
| `deleted_at` | TIMESTAMP | When message was deleted (if applicable) |
| `media_type` | VARCHAR(50) | Type of media (text, photo, video, etc.) |
| `media_urls` | JSON | URLs to media content |
| `created_at` | TIMESTAMP | Record creation timestamp |
| `updated_at` | TIMESTAMP | Last update timestamp |

#### Webhooks Table
| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `url` | VARCHAR(255) | Webhook endpoint URL |
| `event_type` | ENUM | 'new_message', 'deleted_message', 'all' |
| `status` | ENUM | 'active', 'inactive', 'failed' |
| `secret_key` | VARCHAR(255) | Secret for webhook authentication |
| `failure_count` | INTEGER | Count of consecutive failures |
| `last_triggered` | TIMESTAMP | Last successful trigger timestamp |
| `created_at` | TIMESTAMP | Record creation timestamp |
| `updated_at` | TIMESTAMP | Last update timestamp |

#### WebhookDeliveries Table
| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `webhook_id` | UUID | Foreign key to Webhooks table |
| `message_id` | UUID | Foreign key to Messages table (optional) |
| `payload` | JSON | Payload sent to webhook |
| `status_code` | INTEGER | HTTP status code returned |
| `response` | TEXT | Response body |
| `triggered_at` | TIMESTAMP | When webhook was triggered |
| `completed_at` | TIMESTAMP | When webhook completed |
| `success` | BOOLEAN | Whether delivery was successful |

#### Logs Table
| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `timestamp` | TIMESTAMP | When log was created |
| `level` | ENUM | 'info', 'warning', 'error', 'critical' |
| `message` | TEXT | Log message |
| `context` | JSON | Additional context data |
| `account_id` | UUID | Related account (if applicable) |
| `channel_id` | UUID | Related channel (if applicable) |
| `source` | VARCHAR(255) | Source of the log (component name) |

#### AccountChannelAssignments Table
| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key |
| `account_id` | UUID | Foreign key to Accounts table |
| `channel_id` | UUID | Foreign key to Channels table |
| `assigned_at` | TIMESTAMP | When assignment was made |
| `status` | ENUM | 'active', 'failed', 'reassigned' |
| `created_at` | TIMESTAMP | Record creation timestamp |
| `updated_at` | TIMESTAMP | Last update timestamp |

### 5. API Endpoints

#### `POST /api/channel`
- Add a new channel to monitor
- Input: `{ channel_id: string }`
- Checks:
  - Is channel already being monitored?
  - Can one of the accounts join it?
  - If yes, join and start listening

#### `GET /api/channels`
- Get a list of all currently monitored channels

#### `GET /api/logs`
- Fetch system logs for debugging/monitoring

## Backend Flow

### Initialization
1. Load session strings for Telegram accounts
2. Authenticate and store account status
3. Pull all active channels from DB
4. Assign a Telegram account to each channel
5. Start message listeners per channel

### Message Listener
For each active channel:
- Subscribe to new messages
- Subscribe to message deletions
- On event:
  1. Save/update message in DB
  2. Trigger webhook (if configured)

### Add Channel Flow
1. Triggered via API
2. Check if channel is already monitored
3. Assign one account (preferably least loaded)
4. Join the channel
5. Save channel metadata
6. Start listener

## Error Handling and Logging
- Logs every Telegram event, DB update, webhook result
- Alert if:
  - Telegram account gets banned
  - Channel cannot be joined
  - Webhook fails repeatedly

## Folder Structure

telegram-multi-account-service/
├── src/
│   ├── config/                  # Configuration files
│   │   ├── database.js          # Database connection config
│   │   ├── telegram.js          # Telegram API config
│   │   └── app.js               # General app config
│   │
│   ├── models/                  # Database models
│   │   ├── Account.js           # Telegram account model
│   │   ├── Channel.js           # Channel model
│   │   ├── Message.js           # Message model
│   │   ├── Webhook.js           # Webhook model
│   │   ├── WebhookDelivery.js   # Webhook delivery model
│   │   ├── Log.js               # Log model
│   │   └── AccountChannelAssignment.js # Assignment model
│   │
│   ├── services/                # Business logic
│   │   ├── telegram/            # Telegram-related services
│   │   │   ├── client.js        # Telegram client initialization
│   │   │   ├── accountManager.js # Account management
│   │   │   ├── channelMonitor.js # Channel monitoring
│   │   │   └── messageListener.js # Message event handling
│   │   │
│   │   ├── webhook/             # Webhook-related services
│   │   │   ├── dispatcher.js    # Webhook sending logic
│   │   │   └── queue.js         # Queue for webhook delivery
│   │   │
│   │   └── monitoring/          # System monitoring
│   │       ├── healthCheck.js   # Health check service
│   │       └── metrics.js       # Metrics collection
│   │
│   ├── controllers/             # API controllers
│   │   ├── channelController.js # Channel management endpoints
│   │   ├── accountController.js # Account management endpoints
│   │   ├── webhookController.js # Webhook configuration endpoints
│   │   └── logController.js     # Log retrieval endpoints
│   │
│   ├── routes/                  # API routes
│   │   ├── channelRoutes.js     # Channel-related routes
│   │   ├── accountRoutes.js     # Account-related routes
│   │   ├── webhookRoutes.js     # Webhook-related routes
│   │   └── logRoutes.js         # Log-related routes
│   │
│   ├── middleware/              # Express middleware
│   │   ├── auth.js              # Authentication middleware
│   │   ├── errorHandler.js      # Error handling middleware
│   │   └── requestLogger.js     # Request logging middleware
│   │
│   ├── utils/                   # Utility functions
│   │   ├── logger.js            # Logging utility
│   │   ├── database.js          # Database utility functions
│   │   └── validators.js        # Input validation functions
│   │
│   ├── jobs/                    # Background jobs
│   │   ├── webhookRetry.js      # Retry failed webhooks
│   │   ├── accountHealthCheck.js # Check account health
│   │   └── cleanupOldLogs.js    # Clean up old logs
│   │
│   └── app.js                   # Main application entry point
│
├── migrations/                  # Database migrations
│   ├── 20230101000000-create-accounts.js
│   ├── 20230101000001-create-channels.js
│   └── ...
│
├── tests/                       # Test files
│   ├── unit/                    # Unit tests
│   ├── integration/             # Integration tests
│   └── fixtures/                # Test fixtures
│
├── scripts/                     # Utility scripts
│   ├── setup.js                 # Setup script
│   └── seed.js                  # Database seeding
│
├── .env.example                 # Example environment variables
├── .gitignore                   # Git ignore file
├── package.json                 # NPM package file
├── docker-compose.yml           # Docker compose configuration
├── Dockerfile                   # Docker configuration
└── README.md                    # Project documentation


## Tools and Libraries (Recommended)

| Category | Options |
|----------|---------|
| **Telegram API Wrapper** | `telegram` npm module |
| **Database** |  MongoDB |
| **Server Framework** | Express.js  |
| **Logging** | Winston  |
| **Scheduler** | Node-cron  |

## Deployment Considerations
- Use **PM2 or Docker** for process management
- Implement a **healthcheck endpoint** for uptime monitoring
- Use **Redis** for lightweight coordination between processes
- Separate webhook processing into a **job queue** for retries/failover

## Future Improvements
- Admin dashboard for live monitoring
- OAuth + Admin Auth
- Fallback account rotation system
- Channel categorization/tagging

## Summary
This backend ensures reliable monitoring of Telegram channels using multiple accounts, logs and reacts to all activity, and offers real-time control and observability through APIs and logs. It is designed for **high availability and maintainability**, making it ideal for real-world production use cases.
