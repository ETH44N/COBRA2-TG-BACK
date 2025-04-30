const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const xss = require('xss-clean');

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests, please try again later.'
  }
});

// Apply security middleware to app
const applySecurityMiddleware = (app) => {
  // Set security HTTP headers
  app.use(helmet());
  
  // Prevent XSS attacks
  app.use(xss());
  
  // Rate limiting
  app.use('/api', apiLimiter);
  
  return app;
};

module.exports = applySecurityMiddleware; 