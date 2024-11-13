// // process.env.DEBUG = 'true';

// // const logger = require('./lib/logger');
// // const { server } = require('./lib/networking');

// import { createServer } from 'node:http';
// import { server } from 'websocket';

// let allPeers = [];

// async function handler(req, res) {
//     const url = new URL(req.url, `http://${req.headers.host}`);
//     if (url.pathname === '/peers' && req.method === 'GET') {
//         res.end(JSON.stringify(allPeers));
//     }

//     res.end();
// };

// const httpServer = createServer(handler).listen(3030, () => console.log('Server running on port 3030'));
// const websocketServer = new server ({
//     httpServer: httpServer
// });

// websocketServer.on('request', request => {
//     const connection = request.accept(null, request.origin);
//     connection.on('message', message => {
//         const data = JSON.parse(message.utf8Data);
//         allPeers.push(data);
//         console.log(allPeers);
//     });

//     connection.on('close', connection => {
//         allPeers = allPeers.filter(p => p.socketId !== connection.socketId);
//     });
// });
