const express = require('express');

function createRoutes({ collector, monitorControl, db, onEvent }){
	const router = express.Router();

	router.get('/monitor', (req, res)=>{
		res.json(collector.states);
	});

	function stopCollector(req, res){
		monitorControl.stop();
		onEvent('kill', null, `monitoring stopped by ${req.ip}`);
		res.json({ running: false });
	}

	function startCollector(req, res){
		monitorControl.start();
		onEvent('revive', null, `monitoring restarted by ${req.ip}`);
		res.json({ running: true });
	}

	router.post('/api/collector/stop', stopCollector);
	router.post('/api/collector/start', startCollector);
	// legacy v1 endpoints
	router.get('/kill', stopCollector);
	router.get('/revive', startCollector);

	// live servers plus any that only exist in history
	router.get('/api/servers', (req, res)=>{
		const servers = Object.entries(collector.states).map(([name, s])=>({ name, online: !!s.online }));
		const known = new Set(servers.map((s)=>s.name));
		for(const name of db.distinctServers()){
			if(!known.has(name)) servers.push({ name, online: false });
		}
		res.json({ servers });
	});

	// ?server=<name>&from=<epoch s>&to=<epoch s>&bucket=<s>
	// defaults: last 6h, bucket auto-sized to <= ~500 points (min 60s)
	router.get('/api/history', (req, res)=>{
		const server = req.query.server;
		if(!server) return res.status(400).json({ error: 'server parameter required' });
		const now = Math.floor(Date.now() / 1000);
		const to = Number(req.query.to) || now;
		const from = Number(req.query.from) || (to - 6 * 3600);
		let bucket = Number(req.query.bucket) || Math.ceil((to - from) / 500 / 60) * 60;
		bucket = Math.max(60, bucket);
		res.json({ server, from, to, bucket, ...db.queryHistory(server, from, to, bucket) });
	});

	// ?from&to&server&type&limit&offset
	router.get('/api/events', (req, res)=>{
		res.json(db.queryEvents({
			from: Number(req.query.from) || 0,
			to: Number(req.query.to) || Math.floor(Date.now() / 1000),
			server: req.query.server || null,
			type: req.query.type || null,
			limit: Math.min(Number(req.query.limit) || 100, 1000),
			offset: Number(req.query.offset) || 0,
		}));
	});

	// ?from&to&server&user&active&limit&offset (rows overlapping [from,to])
	router.get('/api/usage', (req, res)=>{
		res.json(db.queryUsage({
			from: Number(req.query.from) || 0,
			to: Number(req.query.to) || Math.floor(Date.now() / 1000),
			server: req.query.server || null,
			user: req.query.user || null,
			active: req.query.active === '1' || req.query.active === 'true',
			limit: Math.min(Number(req.query.limit) || 50, 1000),
			offset: Number(req.query.offset) || 0,
		}));
	});

	return router;
}

module.exports = { createRoutes };
