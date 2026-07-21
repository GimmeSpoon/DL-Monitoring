const { readFileSync } = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const config = {
	port: 51234,
	pollIntervalMs: 1000,
	reconnectDelayMs: 10000,
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

module.exports = { config, loadServerList };
