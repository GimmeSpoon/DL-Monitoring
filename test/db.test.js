const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { openDb } = require('../lib/db');

function tmpDb(){
	const dir = mkdtempSync(path.join(os.tmpdir(), 'monitor-db-'));
	return { db: openDb(dir), cleanup: ()=>rmSync(dir, { recursive: true, force: true }) };
}

test('latestStorageEntries keeps the newest scan of every target, not of every kind', ()=>{
	const { db, cleanup } = tmpDb();
	try{
		// two `command` targets in one scope both write kind "custom"; the second
		// scans later. Grouping by kind alone would hide the first one entirely.
		db.insertStorageEntry(1000, 'DGX', 'custom', '', '/raid/chsong', 486, null, 'DGX/command#2');
		db.insertStorageEntry(1053, 'DGX', 'custom', '', '/raid/hub/xet', 900, null, 'DGX/command#3');

		const rows = db.latestStorageEntries('DGX');
		assert.deepStrictEqual(rows.map((r)=>r.name).sort(), ['/raid/chsong', '/raid/hub/xet']);
		assert.deepStrictEqual([...new Set(rows.map((r)=>r.target))].sort(), ['DGX/command#2', 'DGX/command#3']);
	}
	finally{ cleanup(); }
});

test('latestStorageEntries takes only the last scan of a given target', ()=>{
	const { db, cleanup } = tmpDb();
	try{
		db.insertStorageEntry(1000, 'DGX', 'custom', '', '/raid/old', 1, null, 'DGX/command#2');
		db.insertStorageEntry(2000, 'DGX', 'custom', '', '/raid/new', 2, null, 'DGX/command#2');
		const rows = db.latestStorageEntries('DGX');
		assert.deepStrictEqual(rows.map((r)=>r.name), ['/raid/new']);
	}
	finally{ cleanup(); }
});

test('rows written before the target column still load', ()=>{
	const { db, cleanup } = tmpDb();
	try{
		db.insertStorageEntry(1000, 'DGX', 'account', '', 'jhmin', 62, null);  // no target passed
		const rows = db.latestStorageEntries('DGX');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].target, '');
	}
	finally{ cleanup(); }
});
