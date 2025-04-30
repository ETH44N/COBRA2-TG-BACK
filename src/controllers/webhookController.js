const Webhook = require('../models/Webhook');
const WebhookDelivery = require('../models/WebhookDelivery');
const logger = require('../utils/logger');
const appConfig = require('../config/app');

/**
 * Add a new webhook
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const addWebhook = async (req, res) => {
  try {
    const { url, event_type, secret_key } = req.body;
    
    // Create webhook
    const webhook = await Webhook.create({
      url,
      event_type: event_type || 'all',
      secret_key: secret_key || appConfig.webhookSecret,
      status: 'active'
    });
    
    res.status(201).json({
      success: true,
      data: {
        id: webhook._id,
        url: webhook.url,
        event_type: webhook.event_type,
        status: webhook.status
      }
    });
  } catch (error) {
    logger.error(`API error adding webhook: ${error.message}`, {
      source: 'webhook-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Get all webhooks
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getAllWebhooks = async (req, res) => {
  try {
    const webhooks = await Webhook.find({});
    
    res.status(200).json({
      success: true,
      count: webhooks.length,
      data: webhooks.map(webhook => ({
        id: webhook._id,
        url: webhook.url,
        event_type: webhook.event_type,
        status: webhook.status,
        failure_count: webhook.failure_count,
        last_triggered: webhook.last_triggered,
        created_at: webhook.created_at
      }))
    });
  } catch (error) {
    logger.error(`API error getting webhooks: ${error.message}`, {
      source: 'webhook-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * Get webhook deliveries
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const getWebhookDeliveries = async (req, res) => {
  try {
    const { webhook_id, success, limit = 50 } = req.query;
    
    // Build query
    const query = {};
    if (webhook_id) query.webhook_id = webhook_id;
    if (success !== undefined) query.success = success === 'true';
    
    // Get deliveries
    const deliveries = await WebhookDelivery.find(query)
      .sort({ triggered_at: -1 })
      .limit(parseInt(limit, 10))
      .populate('webhook_id', 'url event_type');
    
    res.status(200).json({
      success: true,
      count: deliveries.length,
      data: deliveries.map(delivery => ({
        id: delivery._id,
        webhook_id: delivery.webhook_id._id,
        webhook_url: delivery.webhook_id.url,
        message_id: delivery.message_id,
        status_code: delivery.status_code,
        success: delivery.success,
        triggered_at: delivery.triggered_at,
        completed_at: delivery.completed_at
      }))
    });
  } catch (error) {
    logger.error(`API error getting webhook deliveries: ${error.message}`, {
      source: 'webhook-controller',
      context: { error: error.stack }
    });
    
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

module.exports = {
  addWebhook,
  getAllWebhooks,
  getWebhookDeliveries
}; 