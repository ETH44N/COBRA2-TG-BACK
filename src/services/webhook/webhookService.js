const Webhook = require('../../models/Webhook');
const WebhookDelivery = require('../../models/WebhookDelivery');
const axios = require('axios');
const logger = require('../../utils/logger');

/**
 * Send webhook notification to all registered webhooks
 * @param {string} eventType - Type of event (new_message, deleted_message)
 * @param {Object} data - Event data
 */
const sendWebhookNotification = async (eventType, data) => {
  try {
    // Find all webhooks that should receive this event
    const webhooks = await Webhook.find({
      $or: [
        { event_type: 'all' },
        { event_type: eventType }
      ],
      is_active: true
    });
    
    if (webhooks.length === 0) {
      logger.debug(`No webhooks registered for event type: ${eventType}`, {
        source: 'webhook-service'
      });
      return;
    }
    
    logger.debug(`Sending ${eventType} webhook to ${webhooks.length} endpoints`, {
      source: 'webhook-service'
    });
    
    // Prepare payload
    const payload = {
      event_type: eventType,
      timestamp: new Date().toISOString(),
      data
    };
    
    // Send to each webhook
    const deliveryPromises = webhooks.map(async (webhook) => {
      try {
        // Add webhook secret to headers if available
        const headers = {};
        if (webhook.secret_key) {
          headers['X-Webhook-Secret'] = webhook.secret_key;
        }
        
        // Send request
        const response = await axios.post(webhook.url, payload, {
          headers,
          timeout: 10000 // 10 second timeout
        });
        
        // Record delivery
        await WebhookDelivery.create({
          webhook_id: webhook._id,
          event_type: eventType,
          payload: JSON.stringify(payload),
          status_code: response.status,
          success: true,
          delivered_at: new Date()
        });
        
        logger.info(`Successfully delivered ${eventType} webhook to ${webhook.url}`, {
          source: 'webhook-service'
        });
        
        return true;
      } catch (error) {
        // Record failed delivery
        await WebhookDelivery.create({
          webhook_id: webhook._id,
          event_type: eventType,
          payload: JSON.stringify(payload),
          status_code: error.response ? error.response.status : 0,
          success: false,
          error_message: error.message,
          delivered_at: new Date()
        });
        
        logger.error(`Failed to deliver ${eventType} webhook to ${webhook.url}: ${error.message}`, {
          source: 'webhook-service',
          context: { error: error.stack }
        });
        
        return false;
      }
    });
    
    await Promise.all(deliveryPromises);
  } catch (error) {
    logger.error(`Error sending webhook notifications: ${error.message}`, {
      source: 'webhook-service',
      context: { error: error.stack }
    });
  }
};

module.exports = {
  sendWebhookNotification
}; 