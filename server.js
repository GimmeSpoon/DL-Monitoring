const express = require('express');
const { config, loadServerList, loadServiceList, loadAppConfig } = require('./lib/config');
const { createAuth } = require('./lib/auth');
const { openDb } = require('./lib/db');
const { createEvents } = require('./lib/events');
const { createSessionTracker } = require('./lib/sessions');
const { createAggregator } = require('./lib/aggregator');
const { createCollector } = require('./lib/collector');
const { createStorageScanner } = require('./lib/storage');
const { createSshPool } = require('./lib/ssh-pool');
const { createServiceChecker } = require('./lib/services');
const { createRoutes } = require('./lib/routes');
const pkg = require('./package.json');

// usage: npm start   (SSH auth via ssh-agent or a key file)

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

const onIngest = (name, state, apps)=>{
	aggregator.add(name, state);
	sessions.observe(name, apps);
};

const serverList = loadServerList();
const agentSock = process.env.SSH_AUTH_SOCK || null;
const defaultKey = appConfig.sshPrivateKey || process.env.SSH_PRIVATE_KEY || null;
// only remote (non-local) servers need SSH auth; a per-server key covers its own entry
const remoteNeedingAuth = serverList.filter((s)=>!s.local && !s.privateKey);
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
const collector = createCollector({
	servers: serverList,
	agentSock: agentSock,
	defaultKey: defaultKey,
	pollIntervalMs: config.pollIntervalMs,
	reconnectDelayMs: config.reconnectDelayMs,
	onEvent: onEvent,
	onIngest: onIngest,
});
const monitorControl = collector; // /api/collector stop|start act on this

monitorControl.start();
onEvent('server_start', null, `v${pkg.version} started`);

// per-account storage: slow scanner (default every 6h), separate from the poll
const storage = createStorageScanner({
	collector,
	servers: serverList,
	db,
	onEvent,
	roots: appConfig.storageRoots || config.storageRoots,
	sudo: !!appConfig.storageScanSudo,
	intervalMs: appConfig.storageScanHours ? appConfig.storageScanHours * 3600 * 1000 : config.storageScanIntervalMs,
	timeoutMs: config.storageScanTimeoutMs,
	firstDelayMs: 20000,
});
storage.start();

// services: independent up/down checks over their own SSH pool (separate config,
// separate connections). Dormant when services.json is absent.
const serviceConfig = loadServiceList();
const servicePool = createSshPool({ conns: serviceConfig.connections, agentSock, defaultKey });
const serviceChecker = createServiceChecker({
	services: serviceConfig.services,
	pool: servicePool,
	onEvent,
	intervalMs: appConfig.serviceCheckSeconds ? appConfig.serviceCheckSeconds * 1000 : config.serviceCheckIntervalMs,
	timeoutMs: config.serviceCheckTimeoutMs,
	firstDelayMs: 8000,
});
serviceChecker.start();

setInterval(()=>{
	aggregator.flush();
	sessions.flush();
}, config.flushIntervalMs);

const retention = { metricsDays: 30, eventsDays: 90, usageDays: 365, storageDays: 90, ...(appConfig.retention || {}) };
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
app.use(createRoutes({ collector, monitorControl, db, onEvent, serviceChecker }));
app.use(express.static(config.publicDir));

// listen host/port: env (PORT/HOST) wins, then config.json, then the defaults
const port = Number(process.env.PORT) || appConfig.port || config.port;
const host = process.env.HOST || appConfig.host || config.host;
app.listen(port, host || undefined, ()=>{
	log(`Server Monitor v${pkg.version} listening on ${host || '0.0.0.0'}:${port}`);
});
