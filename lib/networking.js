/**
 * networking.js
 *
 */
const net = require('net');
const { networkInterfaces } = require('os');
const logger = require('./logger');

const port = process.env.PORT || 5123;
let ip;

const seeds = ['seed.publicvoid.nl:5123'];

/**
 *
 * @returns
 */
const getHostIP = () => {
	const interfaces = networkInterfaces();
	const addresses = [];

	for (const iface of Object.values(interfaces)) {
		for (const { address, family, internal } of iface) {
			if (family === 'IPv4' && !internal) {
				addresses.push(address);
			}
		}
	}

	// Assuming there is at least one non-internal IPv4 address
	return addresses[0];
};

/**
 *
 * @param {*} data
 */
const parseIncommingData = (data) => {
	logger.debug(`Incomming data: ${data}`);
};

/**
 *
 * @param {*} type
 * @param {*} data
 */
const broadcast = (type, data) => {
	// Add logic here to loop through all connected clients and send a stringified object indicating a message type and data object.
};

/**
 *
 * @param {*} peer
 */
const connectToPeer = (peer) => {
	const [peer_host, peer_port] = peer.split(':');

	const socket = net.connect(peer_port, peer_host, () => {
		logger.info(`Connected to peer: ${peer}`);
	});

	socket.on('data', parseIncommingData);

	socket.on('connect', () => {
		logger.info(`Connected to peer: ${peer}`);

		socket.write(
			JSON.stringify({
				type: 'version',
				data: { addr_recv: peer, addr_from: `${ip}:${port}` },
			})
		);
		// Add logic here to remember the peers we're connected to, store in peers file etc..
	});

	socket.on('close', (a) => {
		logger.info(`Client disconnect ${peer}`);
		// Add logic here to mark the peer as disconnected..
		setTimeout(() => {
			socket.connect(peer_port, peer_host, () => {
				logger.info(`Reconnected to peer: ${peer}`);
			});
		}, 60000);
	});

	socket.on('error', (error) => {
		logger.error(`Error connecting to ${peer}: ${error}`);
		socket.destroy();
	});
};

/**
 *
 */
const server = net.createServer((socket) => {
	socket.on('data', parseIncommingData);
	socket.on('error', (error) => {
		logger.error(`Error with client connection: ${error}`);
		socket.destroy();
	});
});

server.on('connection', (socket) => {
	logger.info(`New incoming connection... `);
});

server.on('error', (error) => {
	logger.error(`Server error: ${error}`);
});

server.listen({ port }, () => {
	ip = getHostIP();
	logger.info(`Server started on ${ip}:${port}`);
});

// We should also add some logic to log if a peer is connected, and count X amount of retries for reconnects before stoping reconnects.
// Also on disconnect try to reconnect X amount of times max.
[...seeds].forEach(connectToPeer);

module.exports = {
	server,
};
