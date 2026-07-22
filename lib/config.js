const { readFileSync, writeFileSync } = require('fs');
const { randomBytes } = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const config = {
	host: null,        // default: all interfaces. Override via HOST env or config.json "host"
	port: 51234,       // override via PORT env or config.json "port"
	pollIntervalMs: 1000,
	reconnectDelayMs: 10000,
	flushIntervalMs: 60000,
	serverListPath: path.join(ROOT, 'servers.json'),
	configPath: path.join(ROOT, 'config.json'),
	publicDir: path.join(ROOT, 'public'),
	dataDir: path.join(ROOT, 'data'),
};

// load the list of mllab servers (format unchanged from v1: {"servers":[{name,addr,port,username}]})
function loadServerList(){
	return JSON.parse(readFileSync(config.serverListPath, 'utf-8'))['servers'];
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
		writeFileSync(config.configPath, JSON.stringify(cfg, null, 2));
	}
	return cfg;
}

function saveAppConfig(patch){
	const cfg = { ...loadAppConfig(), ...patch };
	writeFileSync(config.configPath, JSON.stringify(cfg, null, 2));
	return cfg;
}

module.exports = { config, loadServerList, loadAppConfig, saveAppConfig };
