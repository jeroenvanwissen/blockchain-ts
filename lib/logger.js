/**
 * logger.js
 *
 */
const winston = require('winston');
const fs = require('fs');
const path = require('path');

// Create the log  directory if it doesn't exist
const logDir = path.resolve(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) {
	fs.mkdirSync(logDir);
}

// Configure Winston logger
const logger = winston.createLogger({
	level: process.env.DEBUG === 'true' ? 'debug' : 'info',
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.printf(
			({ level, message, timestamp }) => `[${timestamp}] [${level}]: ${message}`
		)
	),
	transports: [
		new winston.transports.Console(),
		new winston.transports.File({
			filename: path.resolve(logDir, 'debug.log'),
		}),
	],
});

module.exports = logger;
