const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs');
const { randomBytes } = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'configs');

// Every config file lives in configs/. An install that still keeps one in the
// repo root (where they used to live) keeps working: the root copy is used when
// configs/ doesn't have that file, so nothing has to be moved to upgrade.
function configFile(name){
	const preferred = path.join(CONFIG_DIR, name);
	if(existsSync(preferred)) return preferred;
	const legacy = path.join(ROOT, name);
	return existsSync(legacy) ? legacy : preferred;
}

const config = {
	host: null,        // default: all interfaces. Override via HOST env or config.json "host"
	port: 51234,       // override via PORT env or config.json "port"
	pollIntervalMs: 1000,
	reconnectDelayMs: 10000,
	flushIntervalMs: 60000,
	storageRoots: ['/home'],           // legacy du scan roots, used when storage.json is absent
	storageScanSudo: false,            // prefix repquota/du with `sudo -n` (needs passwordless sudo)
	storageScanIntervalMs: 6 * 3600 * 1000,
	storageScanTimeoutMs: 300000,      // cap a single target's scan command
	serviceCheckIntervalMs: 20000,     // how often to probe service up/down
	serviceCheckTimeoutMs: 20000,      // cap one connection's probe batch
	serverListPath: configFile('servers.json'),
	serviceListPath: configFile('services.json'),
	storageListPath: configFile('storage.json'),
	alarmListPath: configFile('alarms.json'),
	configPath: configFile('config.json'),
	publicDir: path.join(ROOT, 'public'),
	dataDir: path.join(ROOT, 'data'),
};

// load the list of monitored servers (format unchanged from v1: {"servers":[{name,addr,port,username}]})
function loadServerList(){
	return JSON.parse(readFileSync(config.serverListPath, 'utf-8'))['servers'];
}

// load the service-monitoring config: { connections:{name:{...}}, services:[...] }.
// Optional and independent of servers.json — a missing/blank/broken file just
// disables the feature (never throws, so a services typo can't take down monitoring).
function loadServiceList(){
	let raw = null;
	try{ raw = readFileSync(config.serviceListPath, 'utf-8'); }
	catch(e){ return { connections: {}, services: [] }; } // no file: feature off
	if(!raw.trim()) return { connections: {}, services: [] };
	let cfg;
	try{ cfg = JSON.parse(raw); }
	catch(e){ console.error(`${config.serviceListPath} is not valid JSON (${e.message}); services disabled.`); return { connections: {}, services: [] }; }
	return { connections: cfg.connections || {}, services: Array.isArray(cfg.services) ? cfg.services : [] };
}

// load the storage-scan config: { connections:{name:{...}}, targets:[...] }.
// Same shape and same "a broken file only disables the feature" rule as the
// service list — a storage typo must never take monitoring down.
function loadStorageConfig(){
	let raw = null;
	try{ raw = readFileSync(config.storageListPath, 'utf-8'); }
	catch(e){ return null; } // no file: fall back to the legacy config.json settings
	if(!raw.trim()) return null;
	let cfg;
	try{ cfg = JSON.parse(raw); }
	catch(e){ console.error(`${config.storageListPath} is not valid JSON (${e.message}); storage scanning disabled.`); return { connections: {}, targets: [] }; }
	return { connections: cfg.connections || {}, targets: Array.isArray(cfg.targets) ? cfg.targets : [] };
}

// config.json: web password hash + session secret + optional host/port,
// retention (gitignored, auto-created on first run)
function loadAppConfig(){
	let cfg = {};
	let raw = null;
	try{ raw = readFileSync(config.configPath, 'utf-8'); }
	catch(e){ /* first run: file doesn't exist yet */ }
	if(raw !== null && raw.trim() !== ''){
		// fail loudly on a bad edit instead of silently resetting (which would
		// wipe the web password, port, etc.)
		try{ cfg = JSON.parse(raw); }
		catch(e){ throw new Error(`${config.configPath} is not valid JSON (${e.message}). Fix the file (or delete it to start fresh).`); }
	}
	if(!cfg.sessionSecret){
		cfg.sessionSecret = randomBytes(32).toString('hex');
		writeAppConfig(cfg);
	}
	return cfg;
}

function writeAppConfig(cfg){
	mkdirSync(path.dirname(config.configPath), { recursive: true }); // first run: configs/ may not exist
	writeFileSync(config.configPath, JSON.stringify(cfg, null, 2));
}

function saveAppConfig(patch){
	const cfg = { ...loadAppConfig(), ...patch };
	writeAppConfig(cfg);
	return cfg;
}


// load the alarm config: { enabled, origin, channels:{name:{...}}, defaults, rules:[...] }.
// Same "a broken file only disables the feature" rule as services/storage - a
// typo in an alarm rule must never take monitoring down. A missing file means
// no channels and no rules, which is simply "alarms off".
function loadAlarmConfig(){
	let raw = null;
	try{ raw = readFileSync(config.alarmListPath, 'utf-8'); }
	catch(e){ return { channels: {}, rules: [] }; } // no file: feature off
	if(!raw.trim()) return { channels: {}, rules: [] };
	let cfg;
	try{ cfg = JSON.parse(raw); }
	catch(e){ console.error(`${config.alarmListPath} is not valid JSON (${e.message}); alarms disabled.`); return { channels: {}, rules: [] }; }
	return { ...cfg, channels: cfg.channels || {}, rules: Array.isArray(cfg.rules) ? cfg.rules : [] };
}

// Flip one rule's durable fields (currently only `enabled`) from the UI and write
// the file back, so a rule switched off stays off across a restart. Rules are
// matched the same way the manager ids them: explicit `id`, else `name`. The
// whole file is re-read first, so a hand edit made since startup is preserved
// rather than overwritten with stale in-memory state.
function patchAlarmRule(id, patch){
	const raw = readFileSync(config.alarmListPath, 'utf-8');
	const cfg = JSON.parse(raw);
	const rules = Array.isArray(cfg.rules) ? cfg.rules : [];
	const rule = rules.find((r, i)=>String(r.id || r.name || `rule-${i + 1}`) === String(id));
	if(!rule) throw new Error(`no alarm rule "${id}" in ${config.alarmListPath}`);
	if(patch.enabled !== undefined) rule.enabled = !!patch.enabled;
	writeFileSync(config.alarmListPath, JSON.stringify(cfg, null, 2) + '\n');
	return rule;
}

module.exports = { config, loadServerList, loadServiceList, loadStorageConfig, loadAlarmConfig, patchAlarmRule, loadAppConfig, saveAppConfig };
