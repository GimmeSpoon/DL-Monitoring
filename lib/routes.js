const express = require('express');

function createRoutes({ collector, monitorControl, onEvent }){
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

	return router;
}

module.exports = { createRoutes };
