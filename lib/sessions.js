// GPU usage sessions: turns the per-poll (gpu, user) observations into
// (server, gpu, user, start, end) rows. Per-poll pid lists flap (dataloader
// workers), so sessions are keyed by user+gpu, not pid, and only closed
// after a grace period without sightings.
function createSessionTracker({ db, graceS = 60 }){

	const open = {}; // "server|gpu_index|user" -> { id, lastSeen }

	// called on every poll with the parsed compute apps of one server
	function observe(server, apps){
		const now = Math.floor(Date.now() / 1000);
		for(const app of apps){
			if(app.gpu_index === null || app.gpu_index === undefined || !app.user) continue;
			const key = `${server}|${app.gpu_index}|${app.user}`;
			if(!open[key]){
				open[key] = { id: db.openUsage(server, app.gpu_index, app.user, now), lastSeen: now };
			}
			else{
				open[key].lastSeen = now;
			}
		}
	}

	// called periodically (60s): persist last_seen for open sessions (bounds
	// data loss to one flush on crash) and close ones not seen for graceS.
	// Also covers servers that went offline - their sessions simply age out.
	function flush(){
		const now = Math.floor(Date.now() / 1000);
		for(const [key, s] of Object.entries(open)){
			if(now - s.lastSeen > graceS){
				db.closeUsage(s.id, s.lastSeen);
				delete open[key];
			}
			else{
				db.touchUsage(s.id, s.lastSeen);
			}
		}
	}

	return { observe, flush };
}

module.exports = { createSessionTracker };
