const express = require('express');
const { config, loadServerList, loadServiceList, loadStorageConfig, loadAppConfig } = require('./lib/config');
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

// storage and services are rebuildable at runtime (POST /api/config/reload): each
// owns nothing but its own timers and SSH pool, so tearing one down and building it
// from the file again costs a reconnect. `features` is what the routes read, and it
// is mutated in place so a reload is visible without re-mounting the router.
const features = { storage: null, storagePool: null, services: null, servicePool: null };

// storage: slow scanner (default every 6h), separate from the poll. Driven by
// configs/storage.json — its own connections and typed targets. With no such file,
// the legacy config.json settings are used to synthesise one `accounts` target per
// monitored server over the collector's connections (v1/early-v2 behaviour).
function buildStorage(firstDelayMs){
	const cfg = loadStorageConfig();
	const pool = cfg ? createSshPool({ conns: cfg.connections, agentSock, defaultKey }) : null;
	const targets = cfg
		? cfg.targets.map((t)=>({ ...t, pool }))
		: serverList.map((s)=>({
			scope: s.name, connection: s.name, type: 'accounts', pool: collector,
			roots: appConfig.storageRoots || config.storageRoots,
			sudo: !!appConfig.storageScanSudo,
		}));
	features.storagePool = pool;
	features.storage = createStorageScanner({
		targets,
		db,
		onEvent,
		intervalMs: appConfig.storageScanHours ? appConfig.storageScanHours * 3600 * 1000 : config.storageScanIntervalMs,
		timeoutMs: config.storageScanTimeoutMs,
		firstDelayMs,
	});
	features.storage.start();
	return { targets: targets.length, connections: cfg ? Object.keys(cfg.connections).length : 0, source: cfg ? 'storage.json' : 'config.json (legacy)' };
}

// services: independent up/down checks over their own SSH pool (separate config,
// separate connections). Dormant when services.json is absent.
function buildServices(firstDelayMs){
	const cfg = loadServiceList();
	const pool = createSshPool({ conns: cfg.connections, agentSock, defaultKey });
	features.servicePool = pool;
	features.services = createServiceChecker({
		services: cfg.services,
		pool,
		onEvent,
		intervalMs: appConfig.serviceCheckSeconds ? appConfig.serviceCheckSeconds * 1000 : config.serviceCheckIntervalMs,
		timeoutMs: config.serviceCheckTimeoutMs,
		firstDelayMs,
	});
	features.services.start();
	return { services: cfg.services.length, connections: Object.keys(cfg.connections).length };
}

// Re-read both files and swap in fresh instances. The old scanner/checker are
// stopped first, but a pass already in flight runs to completion — it writes the
// same kind of rows to the same DB, so letting it finish is harmless and beats
// leaving a half-scanned target behind. Only a pool we created is disposed; the
// legacy storage path borrows the collector's connections, which must survive.
function reloadFeatures(){
	if(features.storage) features.storage.stop();
	if(features.storagePool) features.storagePool.stop();
	if(features.services) features.services.stop();
	if(features.servicePool) features.servicePool.stop();
	// short first delay: a reload is a deliberate act, so run soon rather than
	// waiting out the settle time a cold start needs
	const storage = buildStorage(2000);
	const services = buildServices(2000);
	return { storage, services };
}

buildStorage(20000);
buildServices(8000);

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
app.use(createRoutes({ collector, monitorControl, db, onEvent, features, reloadFeatures }));
app.use(express.static(config.publicDir));

// listen host/port: env (PORT/HOST) wins, then config.json, then the defaults
const port = Number(process.env.PORT) || appConfig.port || config.port;
const host = process.env.HOST || appConfig.host || config.host;
app.listen(port, host || undefined, ()=>{
	log(`Server Monitor v${pkg.version} listening on ${host || '0.0.0.0'}:${port}`);
});
