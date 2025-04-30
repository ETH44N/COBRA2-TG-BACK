const express = require('express');
const { addNewAccount, getAllAccounts, getAccountById } = require('../controllers/accountController');
const { validate, schemas } = require('../utils/validators');

const router = express.Router();

// Add a new account
router.post('/', validate(schemas.account), addNewAccount);

// Get all accounts
router.get('/', getAllAccounts);

// Get a specific account
router.get('/:id', getAccountById);

module.exports = router; 