const Joi = require('joi');

// Validation schemas
const schemas = {
  // Channel validation
  channel: Joi.object({
    channel_id: Joi.string().required(),
    name: Joi.string(),
    username: Joi.string()
  }),
  
  // Account validation
  account: Joi.object({
    username: Joi.string().required(),
    phone_number: Joi.string().required(),
    session_string: Joi.string().required(),
    max_channels: Joi.number().integer().min(1).max(500)
  }),
  
  // Webhook validation
  webhook: Joi.object({
    url: Joi.string().uri().required(),
    event_type: Joi.string().valid('new_message', 'deleted_message', 'all').default('all'),
    secret_key: Joi.string().required()
  })
};

// Validation middleware
const validate = (schema) => {
  return (req, res, next) => {
    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ 
        success: false, 
        message: error.details[0].message 
      });
    }
    next();
  };
};

module.exports = {
  schemas,
  validate
}; 