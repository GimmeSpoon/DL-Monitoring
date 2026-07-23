const { NodeSSH } = require('node-ssh');
const { exec: execLocal } = require('child_process');
const os = require('os');
const path = require('path');

function expandHome(p){
	return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

// A "connection" that runs commands directly on this host (for `"local": true`),
// same interface as a NodeSSH connection (execCommand / dispose).
function makeLocalConn(){
	return {
		execCommand(cmd){
			return new Promise((resolve, reject)=>{
				execLocal(cmd, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr)=>{
					if(err && err.code === undefined) return reject(err); // spawn failure only
					resolve({ stdout: stdout || '', stderr: stderr || '' });
				});
			});
		},
		dispose(){},
	};
}

// A lazy SSH/local connection pool keyed by connection *name*, independent of the
// monitoring collector. The service checker uses this so services are probed over
// their own SSH identities (a host account, a per-container login, or local) —
// separate from `servers.json`/the poll loop. Connections are opened on first use
// and re-opened on the next call after a drop. Failures surface as a rejected
// exec(); the caller decides how to report them (no events emitted here).
function createSshPool({ conns, agentSock, defaultKey }){
	conns = conns || {};
	const active = {}; // name -> live connection

	async function connect(cfg){
		if(cfg.local) return makeLocalConn();
		const conn = new NodeSSH();
		// keepalive so an idle connection isn't silently dropped by the server
		// between checks (a dropped-but-reused socket would look "unreachable")
		const c = { host: cfg.addr, port: cfg.port, username: cfg.username, readyTimeout: 10000, keepaliveInterval: 15000 };
		const keyPath = expandHome(cfg.privateKey || defaultKey);
		if(keyPath) c.privateKeyPath = keyPath;
		else c.agent = agentSock;
		await conn.connect(c);
		return conn;
	}

	async function exec(name, cmd){
		const cfg = conns[name];
		if(!cfg) throw new Error(`unknown connection "${name}"`);
		if(!active[name]) active[name] = await connect(cfg);
		try{
			return await active[name].execCommand(cmd);
		}
		catch(err){
			try{ active[name].dispose(); } catch(e){ /* already dead */ }
			delete active[name];
			throw err;
		}
	}

	function stop(){
		for(const [name, conn] of Object.entries(active)){
			try{ conn.dispose(); } catch(e){ /* ignore */ }
			delete active[name];
		}
	}

	return { exec, hasConn: (name)=>!!active[name], stop };
}

module.exports = { createSshPool };
