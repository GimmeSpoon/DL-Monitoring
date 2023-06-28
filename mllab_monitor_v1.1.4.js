const http = require('http');
const { readFileSync, writeFileSync, createReadStream } = require('fs');
const { NodeSSH } = require('node-ssh');
const { scryptSync, createCipheriv, createDecipheriv } = require('crypto');
const { Buffer } = require('buffer');
const { cpus } = require('os');

const VERSION = 'V1.1.4'
const LAST_MOD = '2023-05-13'

// Edit configurations as you wish

// basic configurations
const port = 51234
const algorithm = 'aes-192-cbc'
const passwd_path = './passwd.txt'
const server_list_path = './servers.json'
const html_path = './index.html'
const css_path = './index.css'
const favicon_path = './favicon.ico'

var passwd;
let monitoring;
let states = {};
let busy = false;

//######################  MAIN ############################

// Save an encrypted password if provieded.
if (process.argv[2]){ // MASTER PASSWORD
	if (process.argv[3]){ // SSH PASSWORD
		passwd = savePassword(process.argv[3], process.argv[2]);
	}
	else{ // ONLY MASTER PASSWORD
		passwd = loadPassword(process.argv[2]);
	}
}
else{
	throw Error('wtf gimme password');
}

// load a List of mllab servers.
const server_list = JSON.parse(readFileSync(server_list_path, 'utf-8'))['servers'];
var conns = {};
var fails = [];

startMonitoring();

// Simple HTTP server
http.createServer(async (req, res)=>{

	let pathname = req.url;
	console.log(`[${Date.now()}] ${req.socket.remoteAddress} requested ${pathname.toString()}`)

	if(pathname == '/'){ // HTML
		html = readFileSync(html_path, 'utf8').toString();
		res.writeHead(200, {"content-type" : "text/html"});
		res.end(html);
	}
	else if(pathname == '/index.css'){ // CSS
		css = readFileSync(css_path, 'utf8').toString();
		res.writeHead(200, {"content-type" : "text/css"});
		res.end(css);
	}
	else if(pathname == '/monitor'){ // API(JSON)
		res.writeHead(200, { "content-type" : "text/plain", "X-Content-Type-Options":"nosniff"});
		res.end(JSON.stringify(states));
	}
	else if(pathname == '/favicon.ico'){ //favicon
		res.writeHead(200, {"content-type":"image/x-icon"})
		createReadStream(favicon_path).pipe(res);
	}
	else if(pathname == '/kill'){ //special feature to stop monitor to lessen the load
		stopMonitoring();
		res.writeHead(200, {"Content-Type" : "text/plain"});
		res.end("Thank you for killing me.")
	}
	else if(pathname == '/revive'){ //special feature to restart monitoring
		startMonitoring();
		res.writeHead(200, {"Content-Type" : "text/plain"});
		res.end("Thank you for reviving me.")
	}

})
.listen(port, ()=>{

	console.log(`[${Date.now()}] MLLAB Monitoring Server ${VERSION} (${LAST_MOD}) has started :` + port);

});

//#########################################################

// ======================== Functions =============================

// Make interactive shells with pre-defined servers.
function makeCon(){

	return new Promise((resolve, reject)=>{

		server_list.forEach((server)=>{

			let conn = new NodeSSH();
			
			conn.connect({
				host: server['addr'],
				port: server['port'],
				username: server['username'],
				password: passwd,
			})
			.then(()=>{

				console.log(`[${Date.now()}] Server${server['name']} (${server['addr']}) connected.`);
				conns[server['name']] = conn;
				if(Object.keys(conns).length === server_list.length) resolve();
				
			})
			.catch((err)=>{
				console.error(`[${Date.now()}] Connecting server${server['name']} (${server['addr']}) has failed. Reconnection required.`);
				fails.push(server)
				resolve();
				return;
			});
	
		});
	});

}

// Retry to connect when failed connections exist.
function reCon(){

	fails.forEach((server, index, arr)=>{

		let conn = new NodeSSH();
		conn.connect({
			host: server['addr'],
			port: server['port'],
			username: server['username'],
			password: passwd,
		})
		.then(()=>{

			arr.splice(index, 1);
			console.log(`[${Date.now()}] Server${server['name']} (${server['addr']}) reconnected.`);
			conns[server['name']] = conn;
			if(Object.keys(conns).length === server_list.length) resolve();
			
		})
		.catch((err)=>{
			console.error(`[${Date.now()}] Re-establishing a connection with server${server['name']} (${server['addr']}) has failed. Check your server and modify 'server.json'`)
		});

	});
}

// Disconnect every connection
function disCon(){
	return new Promise((resolve, reject)=>{

		conns.forEach((conn)=>{
			conn.dispose();
			const idx = conns.indexOf(conn);
			if(idx > -1) conns.splice(idx, 1);
			if(Object.keys(conns).length === 0) resolve();
		});

	});
}

// Send ssh command to monitor gpu states one time or in a sequence
function getStatus(){

	for(const [server_name, conn] of Object.entries(conns)){

		try{
			// Check if the connection is not null.
			conn.getConnection()

			// get gpustat shell output
			// 'nvidia-smi' is not backwards compatible. Thus might have some bugs after further driver updates.
			conn.execCommand('nvidia-smi --query-gpu=index,timestamp,name,driver_version,display_mode,display_active,fan.speed,temperature.gpu,temperature.memory,power.draw,power.limit,memory.used,memory.total,utilization.gpu,utilization.memory,pstate --format=csv,nounits,noheader && nvidia-smi --query-compute-apps=pid --format=csv,noheader | xargs -r ps -o user:30 --no-header -p && /usr/local/cuda*/bin/nvcc --version')
			.then((res, err)=>{

				if(err){
					fails.push(conn)
					delete conns[server_name]
					console.error(`[${Date.now()}] Requesting server${server['name']} (${server['addr']}) has failed. Reconnection required.`)
					if ( states[server_name] ){
						delete states[server_name];
					}
				}

				if(res.stderr) console.log(res.stderr);

				// This will parse except cuda version and running processes by the limit of the command 'nvidia-smi'
				states[server_name] = parseSMI(server_name, res.stdout); // parse!

				//console.log(JSON.stringify(states, null, 2)) // for debugging
			});
		}
		catch(e){
			fails.push(conn)
			delete conns[server_name]
			console.error(`[${Date.now()}] Requesting server${server['name']} (${server['addr']}) has failed. Reconnection required.`)
			console.error(e)
			if ( states[server_name] ){
				delete states[server_name];
			}
		}
	};
}

// Stop sending execcommand through ssh protocol
function stopMonitoring (){
	disCon().then(()=>{clearInterval(monitoring);});
	busy=false;
}

function startMonitoring (){
	if(!busy){
		makeCon().then(()=>{monitoring = setInterval(()=>{getStatus();reCon();}, 1000);});
	}
	busy=true;
}

// parse the output of the command 'nvidia-smi' in csv format. Edit the query if you want to change the format.
function parseSMI (servn, raw) {
	let gpu_state = [];
	let driver_version;
	let cuda_version = raw.match(/Cuda.+\d+\.\d+\,\s*V([0-9\.]+)/i)
	let users = new Set()

	if(cuda_version){ cuda_version = cuda_version[1]; }
	else{cuda_version = "Not Available";}

	// parse GPU infos
	for(const match of raw.matchAll(/(\d+), (\d\d\d\d\/\d\d\/\d\d \d\d\:\d\d\:\d\d\.\d\d\d), ([\w\d\s]+), ([\d\.]+), (\w+), (\w+), ([\d\w\/]+), ([\d\w\/]+), ([\d\w\/]+), ([\d\w\/\.]+), ([\d\w\/\.]+), ([\d\w\/]+), ([\d\w\/]+), (\d+), (\d+), (P\d+)\s*/g)){

		driver_version = match[4]
		gpu_state.push({
			'gpu_id':match[1],
			'timestamp':match[2],
			'gpu_name':match[3],
			'display_mode':match[5],
			'display_active':match[6],
			'fan_speed':match[7],
			'temperature_gpu':match[8],
			'temperature_memory':match[9],
			'power_draw':match[10],
			'power_limit':match[11],
			'used_memory':match[12],
			'total_memory':match[13],
			'utilization_gpu':match[14],
			'utilization_memory':match[15],
			'pstate':match[16]
		})
		
	}

	// parse usernames
	for(const match of raw.matchAll(/\n([\w\d]+)\s*\n/g)){
		users.add(match[1])
	}

	return {
		'name':servn,
		'driver_version':driver_version,
		'cuda_version':cuda_version,
		'users':Array.from(users),
		'gpus':gpu_state
	}
}

// save encrypted password
function savePassword (password, master) {

	let	key = scryptSync(master, 'salt', 24)
	let iv = Buffer.alloc(16, 0);

	let cipher = createCipheriv(algorithm, key, iv).setEncoding('hex')

	let encrypted = cipher.update(password, 'utf8', 'hex')
	encrypted = cipher.final('hex')

	writeFileSync(passwd_path, encrypted, (err)=>{if(err) console.log(err)});

	console.log("password saved.");

	return password
}

// load and decrypt password
function loadPassword (master) {
	
	let encrypted = readFileSync(passwd_path).toString()

	let key = scryptSync(master, 'salt', 24)
	let iv = Buffer.alloc(16, 0);

	let decipher = createDecipheriv(algorithm, key, iv);
	let decrypted = decipher.update(encrypted, 'hex', 'utf8')
	decrypted += decipher.final('utf8')

	return decrypted
}
