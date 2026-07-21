const express = require('express');
const { config, loadServerList, loadAppConfig } = require('./lib/config');
const { savePassword, loadPassword } = require('./lib/secrets');
const { createAuth } = require('./lib/auth');
const { createCollector } = require('./lib/collector');
const { createMock } = require('./lib/mock');
const { createRoutes } = require('./lib/routes');
const pkg = require('./package.json');

// usage: npm start -- <MASTER_KEY> [<SSH_PASSWORD>] [--mock]
// --mock needs no keys: it serves synthetic servers without SSH.
const argv = process.argv.slice(2);
const mockMode = argv.includes('--mock');
const positional = argv.filter((a)=>!a.startsWith('--'));

function log(msg){
	console.log(`[${new Date().toISOString()}] ${msg}`);
}

// event sink: console for now, additionally persisted to the DB in lib/events.js
const onEvent = (type, server, message)=>{
	log(`(${type}) ${server ? `[${server}] ` : ''}${message}`);
};

const appConfig = loadAppConfig();
if(!appConfig.webPasswordHash){
	console.error('No web password set. Run first: npm run set-web-password -- <password>');
	process.exit(1);
}

let collector;
let monitorControl; // what /kill /revive act on (mock or real collector)

if(mockMode){
	collector = createCollector({ servers: [], password: null, pollIntervalMs: config.pollIntervalMs, reconnectDelayMs: config.reconnectDelayMs, onEvent });
	monitorControl = createMock(collector, { onEvent });
	log('running in --mock mode (synthetic data, no SSH)');
}
else{
	if(!positional[0]){
		console.error('Usage: npm start -- <MASTER_KEY> [<SSH_PASSWORD>] [--mock]');
		process.exit(1);
	}
	const password = positional[1] ? savePassword(positional[1], positional[0]) : loadPassword(positional[0]);
	collector = createCollector({
		servers: loadServerList(),
		password: password,
		pollIntervalMs: config.pollIntervalMs,
		reconnectDelayMs: config.reconnectDelayMs,
		onEvent: onEvent,
	});
	monitorControl = collector;
}

monitorControl.start();

const auth = createAuth({ appConfig, onEvent });

const app = express();
app.use(express.json());
app.use((req, res, next)=>{
	log(`${req.ip} ${req.method} ${req.url}`);
	next();
});
app.use(auth.sessionMiddleware);
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);
app.use(auth.gate);
app.use(createRoutes({ collector, monitorControl, onEvent }));
app.use(express.static(config.publicDir));

app.listen(config.port, ()=>{
	log(`MLLAB Monitoring Server v${pkg.version} has started : ${config.port}`);
});
