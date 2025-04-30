const Webhook = require('../../models/Webhook');
const WebhookDelivery = require('../../models/WebhookDelivery');
const logger = require('../../utils/logger');
const axios = require('axios');
const crypto = require('crypto');
const appConfig = require('../../config/app');

/**
 * Create a signature for webhook payload
 * @param {Object} payload - Webhook payload
 * @param {string} secret - Secret key
 * @returns {string} - HMAC signature
 */
const createSignature = (payload, secret) => {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(payload));
  return hmac.digest('hex');
};

/**
 * Send webhook to a specific endpoint
 * @param {Object} webhook - Webhook document
 * @param {Object} payload - Webhook payload
 * @param {string} messageId - Message ID (optional)
 * @returns {Promise<Object>} - Webhook delivery result
 */
const sendWebhook = async (webhook, payload, messageId = null) => {
  try {
    // Create webhook delivery record
    const delivery = await WebhookDelivery.create({
      webhook_id: webhook._id,
      message_id: messageId,
      payload,
      triggered_at: new Date()
    });
    
    // Add signature to headers
    const signature = createSignature(payload, webhook.secret_key);
    
    // Send webhook
    const response = await axios.post(webhook.url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Monitor-Signature': signature
      },
      timeout: 10000 // 10 seconds timeout
    });
    
    // Update delivery with response
    await WebhookDelivery.findByIdAndUpdate(delivery._id, {
      status_code: response.status,
      response: JSON.stringify(response.data),
      completed_at: new Date(),
      success: true
    });
    
    // Update webhook last triggered
    await Webhook.findByIdAndUpdate(webhook._id, {
      last_triggered: new Date(),
      failure_count: 0
    });
    
    logger.info(`Successfully sent webhook to ${webhook.url}`, {
      source: 'webhook-dispatcher',
      webhook_id: webhook._id,
      delivery_id: delivery._id
    });
    
    return {
      success: true,
      delivery_id: delivery._id
    };
  } catch (error) {
    // Get status code if available
    const statusCode = error.response ? error.response.status : null;
    
    // Update delivery with error
    await WebhookDelivery.findByIdAndUpdate(delivery._id, {
      status_code: statusCode,
      response: error.message,
      completed_at: new Date(),
      success: false
    });
    
    // Increment webhook failure count
    await Webhook.findByIdAndUpdate(webhook._id, {
      $inc: { failure_count: 1 }
    });
    
    // If too many failures, mark webhook as failed
    const updatedWebhook = await Webhook.findById(webhook._id);
    if (updatedWebhook.failure_count >= appConfig.webhookRetryLimit) {
      await Webhook.findByIdAndUpdate(webhook._id, {
        status: 'failed'
      });
      
      logger.error(`Webhook ${webhook.url} marked as failed after ${appConfig.webhookRetryLimit} failures`, {
        source: 'webhook-dispatcher',
        webhook_id: webhook._id
      });
    }
    
    logger.error(`Error sending webhook to ${webhook.url}: ${error.message}`, {
      source: 'webhook-dispatcher',
      webhook_id: webhook._id,
      delivery_id: delivery._id,
      context: { error: error.stack }
    });
    
    return {
      success: false,
      delivery_id: delivery._id,
      error: error.message
    };
  }
};

/**
 * Dispatch an event to all relevant webhooks
 * @param {string} eventType - Event type ('new_message' or 'deleted_message')
 * @param {Object} message - Message document
 */
const dispatchEvent = async (eventType, message) => {
  try {
    // Find all active webhooks for this event type
    const webhooks = await Webhook.find({
      status: 'active',
      $or: [
        { event_type: eventType },
        { event_type: 'all' }
      ]
    });
    
    if (webhooks.length === 0) {
      logger.info(`No active webhooks found for event type: ${eventType}`, {
        source: 'webhook-dispatcher'
      });
      return [];
    }
    
    // Prepare payload
    const payload = {
      event_type: eventType,
      timestamp: new Date().toISOString(),
      message: {
        id: message._id,
        channel_id: message.channel_id,
        telegram_message_id: message.telegram_message_id,
        content: message.content,
        date_sent: message.date_sent,
        sender_id: message.sender_id,
        sender_name: message.sender_name,
        is_deleted: message.is_deleted,
        deleted_at: message.deleted_at,
        media_type: message.media_type,
        media_urls: message.media_urls
      }
    };
    
    // Send to all webhooks
    const results = [];
    for (const webhook of webhooks) {
      const result = await sendWebhook(webhook, payload, message._id);
      results.push({
        webhook_id: webhook._id,
        ...result
      });
    }
    
    return results;
  } catch (error) {
    logger.error(`Error dispatching ${eventType} event: ${error.message}`, {
      source: 'webhook-dispatcher',
      context: { error: error.stack }
    });
    return [];
  }
};

/**
 * Retry failed webhook deliveries
 */
const retryFailedWebhooks = async () => {
  try {
    // Find failed deliveries that are not too old
    const failedDeliveries = await WebhookDelivery.find({
      success: false,
      triggered_at: {
        $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
      }
    }).populate('webhook_id');
    
    logger.info(`Found ${failedDeliveries.length} failed webhook deliveries to retry`, {
      source: 'webhook-dispatcher'
    });
    
    for (const delivery of failedDeliveries) {
      // Skip if webhook is not active
      if (!delivery.webhook_id || delivery.webhook_id.status !== 'active') {
        continue;
      }
      
      // Retry sending
      await sendWebhook(delivery.webhook_id, delivery.payload, delivery.message_id);
    }
  } catch (error) {
    logger.error(`Error retrying failed webhooks: ${error.message}`, {
      source: 'webhook-dispatcher',
      context: { error: error.stack }
    });
  }
};

module.exports = {
  dispatchEvent,
  sendWebhook,
  retryFailedWebhooks
}; 