const { mkdirSync } = require('fs');
const path = require('path');

// Storage backend: node:sqlite (built into Node >= 22.5), falling back to the
// better-sqlite3 npm package on older Nodes. Both expose the same
// constructor/exec/prepare(run|get|all)/close surface used below.
let DatabaseSync;
try{
	DatabaseSync = require('node:sqlite').DatabaseSync;
}
catch(e){
	try{
		DatabaseSync = require('better-sqlite3');
	}
	catch(e2){
		console.error(
			`Your Node (${process.version}) has no built-in sqlite (needs >= 22.5) ` +
			'and better-sqlite3 is not installed.\n' +
			'Either upgrade Node to >= 24 (recommended) or install the fallback driver:\n' +
			'  npm install better-sqlite3     # Node 18/20\n' +
			'  npm install better-sqlite3@8   # Node 14/16');
		process.exit(1);
	}
}

// All timestamps are epoch seconds.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples_sys (
	ts INTEGER NOT NULL, server TEXT NOT NULL,
	cpu_avg REAL, cpu_max REAL, load1 REAL,
	mem_used_avg INTEGER, mem_total INTEGER,
	rx_avg INTEGER, tx_avg INTEGER,
	PRIMARY KEY (server, ts));
CREATE TABLE IF NOT EXISTS samples_gpu (
	ts INTEGER NOT NULL, server TEXT NOT NULL, gpu_index INTEGER NOT NULL,
	util_avg REAL, util_max REAL,
	mem_used_avg REAL, mem_total INTEGER,
	temp_avg REAL, temp_max REAL, power_avg REAL,
	PRIMARY KEY (server, gpu_index, ts));
CREATE TABLE IF NOT EXISTS samples_disk (
	ts INTEGER NOT NULL, server TEXT NOT NULL, mount TEXT NOT NULL,
	used INTEGER, total INTEGER,
	PRIMARY KEY (server, mount, ts));
CREATE TABLE IF NOT EXISTS events (
	id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
	type TEXT NOT NULL, server TEXT, message TEXT);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS gpu_usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	server TEXT NOT NULL, gpu_index INTEGER NOT NULL, username TEXT NOT NULL,
	start_ts INTEGER NOT NULL, end_ts INTEGER, last_seen_ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_usage_start ON gpu_usage(start_ts);
CREATE TABLE IF NOT EXISTS storage_usage (
	ts INTEGER NOT NULL, server TEXT NOT NULL, account TEXT NOT NULL,
	bytes INTEGER,
	PRIMARY KEY (server, account, ts));
CREATE INDEX IF NOT EXISTS idx_storage_server_ts ON storage_usage(server, ts);
CREATE TABLE IF NOT EXISTS storage_entries (
	ts INTEGER NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL,
	parent TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
	bytes INTEGER, meta TEXT,
	PRIMARY KEY (scope, kind, parent, name, ts));
CREATE INDEX IF NOT EXISTS idx_storage_entries ON storage_entries(scope, kind, ts);
`;

// columns added after the tables first shipped; ALTER fails on an already-migrated
// DB, so each is attempted independently and "duplicate column" is ignored.
function migrate(db){
	for(const sql of [
		'ALTER TABLE samples_sys ADD COLUMN rx_avg INTEGER',
		'ALTER TABLE samples_sys ADD COLUMN tx_avg INTEGER',
	]){
		try{ db.exec(sql); }
		catch(e){ if(!/duplicate column/i.test(e.message)) throw e; }
	}

	// storage_usage held only per-account rows; storage_entries generalises it to
	// any (kind, name) pair. Carry the old history over so an upgrade doesn't look
	// like the storage scans lost 90 days, then drop the old table — INSERT OR
	// IGNORE makes the copy a no-op if it somehow runs twice, so there is no
	// ordering hazard between the two statements.
	const legacy = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='storage_usage'`).get();
	if(legacy){
		db.exec(`INSERT OR IGNORE INTO storage_entries (ts,scope,kind,parent,name,bytes)
			SELECT ts, server, 'account', '', account, bytes FROM storage_usage`);
		db.exec('DROP TABLE storage_usage');
	}
}

function openDb(dataDir, filename = 'monitor.db'){
	mkdirSync(dataDir, { recursive: true });
	const db = new DatabaseSync(path.join(dataDir, filename));
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec(SCHEMA);
	migrate(db);

	const stmt = {
		sys: db.prepare('INSERT OR REPLACE INTO samples_sys (ts,server,cpu_avg,cpu_max,load1,mem_used_avg,mem_total,rx_avg,tx_avg) VALUES (?,?,?,?,?,?,?,?,?)'),
		gpu: db.prepare('INSERT OR REPLACE INTO samples_gpu (ts,server,gpu_index,util_avg,util_max,mem_used_avg,mem_total,temp_avg,temp_max,power_avg) VALUES (?,?,?,?,?,?,?,?,?,?)'),
		disk: db.prepare('INSERT OR REPLACE INTO samples_disk (ts,server,mount,used,total) VALUES (?,?,?,?,?)'),
		event: db.prepare('INSERT INTO events (ts,type,server,message) VALUES (?,?,?,?)'),
		usageOpen: db.prepare('INSERT INTO gpu_usage (server,gpu_index,username,start_ts,last_seen_ts) VALUES (?,?,?,?,?)'),
		usageTouch: db.prepare('UPDATE gpu_usage SET last_seen_ts=? WHERE id=?'),
		usageClose: db.prepare('UPDATE gpu_usage SET end_ts=?, last_seen_ts=? WHERE id=?'),
		storage: db.prepare('INSERT OR REPLACE INTO storage_entries (ts,scope,kind,parent,name,bytes,meta) VALUES (?,?,?,?,?,?,?)'),
	};

	return {
		insertSysSample: (ts, server, s)=>stmt.sys.run(ts, server, s.cpu_avg, s.cpu_max, s.load1, s.mem_used_avg, s.mem_total, s.rx_avg, s.tx_avg),
		insertGpuSample: (ts, server, gpuIndex, g)=>stmt.gpu.run(ts, server, gpuIndex, g.util_avg, g.util_max, g.mem_used_avg, g.mem_total, g.temp_avg, g.temp_max, g.power_avg),
		insertDiskSample: (ts, server, mount, d)=>stmt.disk.run(ts, server, mount, d.used, d.total),
		insertEvent: (ts, type, server, message)=>stmt.event.run(ts, type, server, message),

		openUsage: (server, gpuIndex, username, ts)=>Number(stmt.usageOpen.run(server, gpuIndex, username, ts, ts).lastInsertRowid),
		touchUsage: (id, lastSeen)=>stmt.usageTouch.run(lastSeen, id),
		closeUsage: (id, endTs)=>stmt.usageClose.run(endTs, endTs, id),
		// crashed/restarted mid-session: close dangling rows at their last flush
		closeDanglingUsage: ()=>db.prepare('UPDATE gpu_usage SET end_ts=last_seen_ts WHERE end_ts IS NULL').run(),

		distinctServers: ()=>db.prepare('SELECT DISTINCT server FROM samples_sys ORDER BY server').all().map((r)=>r.server),

		queryHistory: (server, from, to, bucket)=>{
			const sys = db.prepare(`
				SELECT (ts/?)*? AS ts, AVG(cpu_avg) AS cpu, MAX(cpu_max) AS cpu_max, AVG(load1) AS load1,
				       AVG(mem_used_avg) AS mem_used, MAX(mem_total) AS mem_total,
				       AVG(rx_avg) AS rx, AVG(tx_avg) AS tx
				FROM samples_sys WHERE server=? AND ts BETWEEN ? AND ?
				GROUP BY 1 ORDER BY 1`).all(bucket, bucket, server, from, to);
			const gpuRows = db.prepare(`
				SELECT gpu_index, (ts/?)*? AS ts, AVG(util_avg) AS util, MAX(util_max) AS util_max,
				       AVG(mem_used_avg) AS mem_used, MAX(mem_total) AS mem_total,
				       AVG(temp_avg) AS temp, MAX(temp_max) AS temp_max, AVG(power_avg) AS power
				FROM samples_gpu WHERE server=? AND ts BETWEEN ? AND ?
				GROUP BY gpu_index, 2 ORDER BY 2`).all(bucket, bucket, server, from, to);
			const diskRows = db.prepare(`
				SELECT mount, (ts/?)*? AS ts, AVG(used) AS used, MAX(total) AS total
				FROM samples_disk WHERE server=? AND ts BETWEEN ? AND ?
				GROUP BY mount, 2 ORDER BY 2`).all(bucket, bucket, server, from, to);

			const gpus = {};
			for(const r of gpuRows){
				(gpus[r.gpu_index] = gpus[r.gpu_index] || []).push({ ts: r.ts, util: r.util, util_max: r.util_max, mem_used: r.mem_used, mem_total: r.mem_total, temp: r.temp, temp_max: r.temp_max, power: r.power });
			}
			const disks = {};
			for(const r of diskRows){
				(disks[r.mount] = disks[r.mount] || []).push({ ts: r.ts, used: r.used, total: r.total });
			}
			return { system: sys, gpus, disks };
		},

		queryEvents: ({ from, to, server, type, limit, offset })=>{
			const where = ['ts BETWEEN ? AND ?'];
			const params = [from, to];
			if(server){ where.push('server=?'); params.push(server); }
			if(type){ where.push('type=?'); params.push(type); }
			const w = where.join(' AND ');
			const total = db.prepare(`SELECT COUNT(*) AS c FROM events WHERE ${w}`).get(...params).c;
			const rows = db.prepare(`SELECT * FROM events WHERE ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
			return { total, rows };
		},

		insertStorageEntry: (ts, scope, kind, parent, name, bytes, meta)=>stmt.storage.run(ts, scope, kind, parent, name, bytes, meta),

		// Latest scan per *kind*, not per scope: targets run on independent
		// schedules, so a scope-wide MAX(ts) would hide every kind whose target
		// simply hasn't been due as recently as another's.
		latestStorageEntries: (scope)=>{
			// CAST to REAL: a row written before `du -sB1` can hold an apparent size
			// past 2^53, which the driver refuses to return as a JS number — one
			// such row would otherwise 500 the whole storage API.
			const rows = db.prepare(`
				SELECT e.ts, e.kind, e.parent, e.name, CAST(e.bytes AS REAL) AS bytes, e.meta
				FROM storage_entries e
				JOIN (SELECT kind, MAX(ts) AS ts FROM storage_entries WHERE scope=? GROUP BY kind) m
				  ON e.kind = m.kind AND e.ts = m.ts
				WHERE e.scope=? ORDER BY e.bytes DESC`).all(scope, scope);
			return rows.map((r)=>({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
		},

		distinctStorageScopes: ()=>db.prepare('SELECT DISTINCT scope FROM storage_entries ORDER BY scope').all().map((r)=>r.scope),

		// last persisted per-mount capacity (fallback for an offline server's card)
		latestDisks: (server)=>{
			const row = db.prepare('SELECT MAX(ts) AS ts FROM samples_disk WHERE server=?').get(server);
			if(!row || row.ts == null) return [];
			return db.prepare('SELECT mount, used, total FROM samples_disk WHERE server=? AND ts=? ORDER BY mount').all(server, row.ts);
		},

		queryUsage: ({ from, to, server, user, active, limit, offset })=>{
			// overlap with [from, to]: started before `to` and not ended before `from`
			const where = ['start_ts <= ?', '(end_ts IS NULL OR end_ts >= ?)'];
			const params = [to, from];
			if(server){ where.push('server=?'); params.push(server); }
			if(user){ where.push('username=?'); params.push(user); }
			if(active) where.push('end_ts IS NULL');
			const w = where.join(' AND ');
			const total = db.prepare(`SELECT COUNT(*) AS c FROM gpu_usage WHERE ${w}`).get(...params).c;
			const rows = db.prepare(`SELECT * FROM gpu_usage WHERE ${w} ORDER BY start_ts DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
			return { total, rows };
		},

		prune: ({ metricsDays, eventsDays, usageDays, storageDays })=>{
			const now = Math.floor(Date.now() / 1000);
			db.prepare('DELETE FROM samples_sys WHERE ts < ?').run(now - metricsDays * 86400);
			db.prepare('DELETE FROM samples_gpu WHERE ts < ?').run(now - metricsDays * 86400);
			db.prepare('DELETE FROM samples_disk WHERE ts < ?').run(now - metricsDays * 86400);
			db.prepare('DELETE FROM events WHERE ts < ?').run(now - eventsDays * 86400);
			db.prepare('DELETE FROM gpu_usage WHERE end_ts IS NOT NULL AND end_ts < ?').run(now - usageDays * 86400);
			db.prepare('DELETE FROM storage_entries WHERE ts < ?').run(now - storageDays * 86400);
		},

		close: ()=>db.close(),
	};
}

module.exports = { openDb };
