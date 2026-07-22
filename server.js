const express = require('express');
const { config, loadServerList, loadAppConfig } = require('./lib/config');
const { createAuth } = require('./lib/auth');
const { openDb } = require('./lib/db');
const { createEvents } = require('./lib/events');
const { createSessionTracker } = require('./lib/sessions');
const { createAggregator } = require('./lib/aggregator');
const { createCollector } = require('./lib/collector');
const { createMock } = require('./lib/mock');
const { createRoutes } = require('./lib/routes');
const pkg = require('./package.json');

// usage: npm start            (SSH auth via ssh-agent or a key file)
//        npm start -- --mock  (synthetic data, no SSH)
const mockMode = process.argv.slice(2).includes('--mock');

function log(msg){
	console.log(`[${new Date().toISOString()}] ${msg}`);
}

const db = openDb(config.dataDir);
db.closeDanglingUsage(); // sessions left open by a crash/restart

const onEvent = createEvents({ db, log }).logEvent;
const sessions = createSessionTracker({ db });
const aggregator = createAggregator({ db });

const appConfig = loadAppConfig();
if(!appConfig.webPasswordHash){
	console.error('No web password set. Run first: npm run set-web-password -- <password>');
	process.exit(1);
}

let collector;
let monitorControl; // what /kill /revive act on (mock or real collector)

const onIngest = (name, state, apps)=>{
	aggregator.add(name, state);
	sessions.observe(name, apps);
};

if(mockMode){
	collector = createCollector({ servers: [], agentSock: null, defaultKey: null, pollIntervalMs: config.pollIntervalMs, reconnectDelayMs: config.reconnectDelayMs, onEvent, onIngest });
	monitorControl = createMock(collector, { onEvent });
	log('running in --mock mode (synthetic data, no SSH)');
}
else{
	const servers = loadServerList();
	const agentSock = process.env.SSH_AUTH_SOCK || null;
	const defaultKey = appConfig.sshPrivateKey || process.env.SSH_PRIVATE_KEY || null;
	// only remote (non-local) servers need SSH auth; a per-server key covers its own entry
	const remoteNeedingAuth = servers.filter((s)=>!s.local && !s.privateKey);
	if(remoteNeedingAuth.length && !agentSock && !defaultKey){
		console.error([
			`No SSH authentication for remote servers (${remoteNeedingAuth.map((s)=>s.name).join(', ')}). Pick one:`,
			'  ssh-agent:  eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_ed25519   (re-run after every reboot)',
			'  key file:   export SSH_PRIVATE_KEY=~/.ssh/id_ed25519              (survives reboot; best for a service)',
			'              or set "sshPrivateKey" in config.json, or "privateKey" per server in servers.json',
			'  local box:  add "local": true to a server entry to skip SSH for the machine this runs on',
		].join('\n'));
		process.exit(1);
	}
	collector = createCollector({
		servers: servers,
		agentSock: agentSock,
		defaultKey: defaultKey,
		pollIntervalMs: config.pollIntervalMs,
		reconnectDelayMs: config.reconnectDelayMs,
		onEvent: onEvent,
		onIngest: onIngest,
	});
	monitorControl = collector;
}

monitorControl.start();
onEvent('server_start', null, `v${pkg.version} started${mockMode ? ' (mock)' : ''}`);

setInterval(()=>{
	aggregator.flush();
	sessions.flush();
}, config.flushIntervalMs);

const retention = { metricsDays: 30, eventsDays: 90, usageDays: 365, ...(appConfig.retention || {}) };
setInterval(()=>db.prune(retention), 3600 * 1000);

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
app.use(createRoutes({ collector, monitorControl, db, onEvent }));
app.use(express.static(config.publicDir));

// listen host/port: env (PORT/HOST) wins, then config.json, then the defaults
const port = Number(process.env.PORT) || appConfig.port || config.port;
const host = process.env.HOST || appConfig.host || config.host;
app.listen(port, host || undefined, ()=>{
	log(`MLLAB Monitoring Server v${pkg.version} listening on ${host || '0.0.0.0'}:${port}`);
});
