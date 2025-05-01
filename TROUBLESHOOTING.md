# Troubleshooting Guide

This guide addresses common issues with the Telegram Monitoring System.

## Table of Contents

1. [Environment Configuration Issues](#environment-configuration-issues)
2. [Telegram Connection Issues](#telegram-connection-issues)
3. [Database Issues](#database-issues)
4. [Event Detection Issues](#event-detection-issues)
5. [Message Processing Issues](#message-processing-issues)
6. [API Endpoint Issues](#api-endpoint-issues)

## Environment Configuration Issues

### Problem: Missing or Invalid Environment Variables

**Symptoms:**
- Application fails to start
- "Missing environment variable" errors
- "TELEGRAM_API_ID must be a valid number" error

**Solution:**
1. Run the environment check script:
   ```
   npm run check-env
   ```
2. Make sure your `.env` file exists in the project root and contains:
   ```
   MONGODB_URI=your_mongodb_connection_string
   TELEGRAM_API_ID=your_api_id
   TELEGRAM_API_HASH=your_api_hash
   PORT=3000
   ```
3. Ensure `TELEGRAM_API_ID` is a valid number (not in quotes)

### Problem: GramJS Version Compatibility

**Symptoms:**
- Connection works but events aren't detected
- `TypeError: builder.resolve is not a function` error

**Solution:**
1. Update GramJS to the latest version:
   ```
   npm install telegram@latest
   ```
2. Restart the application

## Telegram Connection Issues

### Problem: Cannot Connect to Telegram

**Symptoms:**
- "Failed to connect to Telegram" errors
- Timeout errors when trying to connect

**Solution:**
1. Test your Telegram connection:
   ```
   npm run test-telegram
   ```
2. Check if your API credentials are correct
3. Check if your account session is valid
4. Try using a different network (some ISPs block Telegram)

### Problem: Invalid Session String

**Symptoms:**
- "AuthKeyUnregistered" or "AUTH_KEY_UNREGISTERED" errors
- Account shows as disconnected shortly after connection

**Solution:**
1. Re-authenticate your account through the API
2. Update the session string in the database
3. Check if your account has been banned or limited by Telegram

## Database Issues

### Problem: Cannot Connect to MongoDB

**Symptoms:**
- "MongoDB connection error" in logs
- Application fails to start

**Solution:**
1. Verify your MongoDB connection string in the `.env` file
2. Check if MongoDB is running
3. Try connecting with MongoDB Compass or another tool
4. Check for network issues or firewall restrictions

### Problem: Message Duplication

**Symptoms:**
- Same messages appear multiple times in the dashboard
- Database contains duplicate message entries

**Solution:**
1. Check the message processing logic in `src/services/telegram/messageListener.js`
2. Ensure uniqueness checks are working properly
3. Run database cleanup to remove duplicates

## Event Detection Issues

### Problem: No Events Detected from Channels

**Symptoms:**
- No new messages are detected
- Logs don't show event handler firing

**Solution:**
1. Switch to polling mode:
   ```
   npm run test-polling
   ```
2. Check if your account has proper access to the channel
3. Verify the channel is sending messages during testing
4. Check if Telegram is rate-limiting your account

### Problem: Events are Detected but Messages Not Processed

**Symptoms:**
- Logs show events but no messages are saved
- Error processing message in logs

**Solution:**
1. Check for circular reference errors in processing
2. Look for exceptions in message processing pipeline
3. Verify channel and message schemas match expected format

## Message Processing Issues

### Problem: Circular Reference Errors

**Symptoms:**
- "Converting circular structure to JSON" errors
- Messages detected but not saved

**Solution:**
1. Use the safe message extraction function:
   ```javascript
   const safeData = extractMessageData(message);
   ```
2. Avoid directly stringifying message objects
3. Check message processing in `messageListener.js`

### Problem: Media Not Detected

**Symptoms:**
- Text messages work but media messages don't
- Media type always shows as null

**Solution:**
1. Check media extraction logic
2. Verify GramJS version supports the media types
3. Ensure account has permission to view media

## API Endpoint Issues

### Problem: API Returns 404 or 500 Errors

**Symptoms:**
- API endpoints return errors
- Swagger documentation unreachable

**Solution:**
1. Check if API server is running on the expected port
2. Verify route definitions in the router files
3. Look for syntax errors in route handlers
4. Check logs for detailed error information

### Problem: Monitor Status Endpoint Fails

**Symptoms:**
- `/api/messages/monitor-status` returns error
- "Cannot read properties of undefined" errors

**Solution:**
1. Check if `channelMonitor` is properly exported
2. Verify the structure of the exported module
3. Test the diagnostics endpoint:
   ```
   curl http://localhost:3000/api/messages/diagnostics
   ```

## Additional Troubleshooting Tools

### Comprehensive Diagnostics

Run the full diagnostics script:
```
npm run diagnose
```

This tests every aspect of the system and provides detailed feedback.

### Environment Check

Verify your environment configuration:
```
npm run check-env
```

### Telegram Connection Test

Test basic Telegram connectivity:
```
npm run test-telegram
```

### Message Polling Test

Test the message polling system:
```
npm run test-polling
```

## Need More Help?

If you're still experiencing issues after trying these solutions, please:

1. Check the application logs for detailed error messages
2. Run `npm run diagnose` and share the output
3. Check for similar issues in the GitHub repository

---

This troubleshooting guide will be updated regularly with new solutions as they are discovered. 