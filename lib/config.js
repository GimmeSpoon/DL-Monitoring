const { readFileSync, writeFileSync } = require('fs');
const { randomBytes } = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const config = {
	port: 51234,
	pollIntervalMs: 1000,
	reconnectDelayMs: 10000,
	flushIntervalMs: 60000,
	passwdPath: path.join(ROOT, 'passwd.txt'),
	serverListPath: path.join(ROOT, 'servers.json'),
	configPath: path.join(ROOT, 'config.json'),
	publicDir: path.join(ROOT, 'public'),
	dataDir: path.join(ROOT, 'data'),
};

// load the list of mllab servers (format unchanged from v1: {"servers":[{name,addr,port,username}]})
function loadServerList(){
	return JSON.parse(readFileSync(config.serverListPath, 'utf-8'))['servers'];
}

// config.json: web password hash + session secret (gitignored, auto-created)
function loadAppConfig(){
	let cfg = {};
	try{
		cfg = JSON.parse(readFileSync(config.configPath, 'utf-8'));
	}
	catch(e){ /* first run */ }
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
