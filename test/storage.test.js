const test = require('node:test');
const assert = require('node:assert');
const {
	normalize, makeMatcher, accountsCommand, parseAccounts,
	containersCommand, parseContainers, buildContainerEntries, humanBytes, parseSized, targetKinds,
} = require('../lib/storage');

test('accounts: quota output wins over du', ()=>{
	const raw = [
		'@@QUOTA',
		'*** Report for user quotas on device /dev/sda1',
		'User            used    soft    hard  grace',
		'alice     --  1048576       0       0',
		'bob       +-  2097152 1000000 3000000  6days',
	].join('\n');
	const { entries, method } = parseAccounts(raw);
	assert.strictEqual(method, 'quota');
	assert.deepStrictEqual(entries.sort((a, b)=>a.name.localeCompare(b.name)), [
		{ kind: 'account', name: 'alice', bytes: 1048576 * 1024 },
		{ kind: 'account', name: 'bob', bytes: 2097152 * 1024 },
	]);
});

test('accounts: du fallback keys on the last path component', ()=>{
	const { entries, method } = parseAccounts('@@DU\n4096\t/home/alice\n8192\t/home/bob/\n');
	assert.strictEqual(method, 'du');
	assert.deepStrictEqual(entries, [
		{ kind: 'account', name: 'alice', bytes: 4096 },
		{ kind: 'account', name: 'bob', bytes: 8192 },
	]);
	assert.deepStrictEqual(parseAccounts('').entries, []);
});

test('accounts: strategy pins one method, sudo prefixes the privileged binary', ()=>{
	const t = normalize({ type: 'accounts', roots: ['/home/'], sudo: true, strategy: 'du' }, 0);
	const cmd = accountsCommand(t);
	assert.match(cmd, /sudo -n du -sB1 "\/home"\/\*/); // -B1: allocated, not apparent
	assert.doesNotMatch(cmd, /repquota/);
	assert.doesNotMatch(cmd, /du[^|]*2>\/dev\/null/);  // du's stderr must reach the status panel
	assert.match(accountsCommand(normalize({ type: 'accounts', strategy: 'quota' }, 0)), /^echo @@QUOTA; repquota -a/);
	assert.match(accountsCommand(normalize({ type: 'accounts' }, 0)), /repquota[\s\S]*du -sB1/); // auto: try quota, else du
});

test('parseSized drops a value past 2^53 rather than poisoning the API', ()=>{
	// du -b on a sparse file really does report ~64PiB; sqlite stores it, then
	// refuses to hand it back as a JS number
	assert.deepStrictEqual(parseSized(['72068691744390784\t/mnt/sparse', '4096\t/mnt/real']), [
		{ name: '/mnt/real', bytes: 4096 },
	]);
	assert.deepStrictEqual(parseSized([`${Number.MAX_SAFE_INTEGER}\t/edge`]), [
		{ name: '/edge', bytes: Number.MAX_SAFE_INTEGER },
	]);
});

test('containers: -s and the inspect pass are only asked for when their layer is on', ()=>{
	const both = containersCommand(normalize({ type: 'containers', sudo: true }, 0));
	assert.match(both, /sudo -n docker ps -a --no-trunc -s/);
	assert.match(both, /docker inspect --format/);

	const light = containersCommand(normalize({ type: 'containers', layers: ['writable'] }, 0));
	assert.match(light, /ps -a --no-trunc -s/);
	assert.doesNotMatch(light, /inspect/);

	const mountsOnly = containersCommand(normalize({ type: 'containers', layers: ['mounts'] }, 0));
	assert.doesNotMatch(mountsOnly, /--no-trunc -s/); // no size computation
	assert.match(mountsOnly, /inspect/);

	// an unknown layer name must not silently disable every measurement
	assert.deepStrictEqual(normalize({ type: 'containers', layers: ['nonsense'] }, 0).layers, ['writable']);
	assert.strictEqual(normalize({ type: 'containers', engine: 'podman' }, 0).engine, 'podman');
});

test('containers: parses sizes and mounts, and charges shared sources to both', ()=>{
	const raw = [
		'@@PS',
		'infer-api|12.3GB (virtual 5.6GB)|Up 3 days (healthy)|myrepo/infer:1.2',
		'train-box|340MB (virtual 8.1GB)|Exited (0) 2 hours ago|pytorch:2.4',
		'@@MOUNTS',
		'/infer-api|bind;/data/models;/models|volume;/var/lib/docker/volumes/cache/_data;/cache',
		'/train-box|bind;/data/models;/mnt/models',
	].join('\n');
	const { containers, error } = parseContainers(raw);
	assert.strictEqual(error, null);
	assert.strictEqual(containers.length, 2);

	const api = containers[0];
	assert.strictEqual(api.writable, 12.3e9);
	assert.strictEqual(api.virtual, 5.6e9);
	assert.strictEqual(api.image, 'myrepo/infer:1.2');
	assert.deepStrictEqual(api.mounts[0], { type: 'bind', source: '/data/models', dest: '/models' });

	const entries = buildContainerEntries(containers, { '/data/models': 1000, '/var/lib/docker/volumes/cache/_data': 500 });
	const byKey = Object.fromEntries(entries.map((e)=>[`${e.kind}:${e.parent || ''}:${e.name}`, e]));
	assert.strictEqual(byKey['container::infer-api'].bytes, 12.3e9 + 1500);
	assert.strictEqual(byKey['container::train-box'].bytes, 340e6 + 1000);
	assert.strictEqual(byKey['mount:infer-api:/models'].meta.shared, 2); // same source in both
	assert.strictEqual(byKey['mount:train-box:/mnt/models'].bytes, 1000);
	assert.strictEqual(byKey['container::infer-api'].meta.mounted, 1500);
});

test('containers: an engine error surfaces instead of reading as zero containers', ()=>{
	const { containers, error } = parseContainers('@@PS\npermission denied while trying to connect to the Docker daemon socket\n');
	assert.deepStrictEqual(containers, []);
	assert.match(error, /permission denied/);

	// a mount with no measured source is skipped rather than counted as 0
	const only = parseContainers('@@PS\nc1|0B|Up|img\n@@MOUNTS\n/c1|bind;/etc/localtime;/etc/localtime').containers;
	assert.deepStrictEqual(buildContainerEntries(only, {}).map((e)=>e.kind), ['container']);
});

test('humanBytes handles docker SI units, binary units and junk', ()=>{
	assert.strictEqual(humanBytes('0B'), 0);
	assert.strictEqual(humanBytes('1.09kB'), 1090);
	assert.strictEqual(humanBytes('12.3GB (virtual 5.6GB)'), 12.3e9);
	assert.strictEqual(humanBytes('4MiB'), 4194304);
	assert.strictEqual(humanBytes('N/A'), 0);
});

test('parseSized keeps paths with spaces and drops noise', ()=>{
	assert.deepStrictEqual(parseSized(['4096\t/data/my models', 'du: cannot read', '', '10 /tmp']), [
		{ name: '/data/my models', bytes: 4096 },
		{ name: '/tmp', bytes: 10 },
	]);
});

test('exclude patterns: exact name, glob, path prefix', ()=>{
	const m = makeMatcher(['root', 'k8s_*', '/srv/shared']);
	assert.ok(m('root'));
	assert.ok(!m('rootish'));
	assert.ok(m('k8s_pause_abc'));
	assert.ok(m('/srv/shared'));
	assert.ok(m('/srv/shared/datasets'));  // prefix covers everything under it
	assert.ok(!m('/srv/shared-old'));      // ...but not a sibling with the same start
	assert.ok(m('nope', '/srv/shared'));   // any value matching is a match
	assert.ok(!makeMatcher([])('anything'));
});

test('exclude drops a shared mount from every container that mounts it', ()=>{
	const t = normalize({ type: 'containers', exclude: ['/data/models', 'train-box'] }, 0);
	const { containers } = parseContainers([
		'@@PS',
		'infer-api|12.3GB (virtual 5.6GB)|Up|img',
		'train-box|340MB|Up|img',
		'@@MOUNTS',
		'/infer-api|bind;/data/models;/models|bind;/data/logs;/logs',
		'/train-box|bind;/data/models;/mnt/models',
	].join('\n'));

	const kept = containers.filter((c)=>!t.excluded(c.name));
	assert.deepStrictEqual(kept.map((c)=>c.name), ['infer-api']);
	for(const c of kept) c.mounts = c.mounts.filter((m)=>!t.excludedMount(m.source, m.dest));
	assert.deepStrictEqual(kept[0].mounts.map((m)=>m.source), ['/data/logs']);

	// and the shared source never reaches the du, nor the container's total
	const entries = buildContainerEntries(kept, { '/data/logs': 500 });
	assert.strictEqual(entries.find((e)=>e.kind === 'container').bytes, 12.3e9 + 500);
	assert.deepStrictEqual(entries.filter((e)=>e.kind === 'mount').map((e)=>e.name), ['/logs']);
});

test('normalize keeps the plumbing defaults when exclude is set', ()=>{
	const t = normalize({ type: 'containers', exclude: ['/srv/shared'] }, 0);
	assert.ok(t.excludedMount('/etc/localtime'));  // default list still applies
	assert.ok(t.excludedMount('/srv/shared'));
	assert.ok(!t.excluded('/etc/localtime'));      // ...but only to mounts
	assert.deepStrictEqual(normalize({ type: 'accounts' }, 0).exclude, []);
});

test('normalize defaults scope to the connection and ids each target', ()=>{
	const t = normalize({ type: 'paths', connection: 'gpu-1', paths: ['/data'] }, 2);
	assert.strictEqual(t.scope, 'gpu-1');
	assert.strictEqual(t.id, 'gpu-1/paths#2');
	assert.strictEqual(t.label, 'paths');
	assert.strictEqual(normalize({ type: 'accounts' }, 0).roots[0], '/home');
});

test('targetKinds: a target only claims the kinds it still produces', ()=>{
	const kinds = (def)=>targetKinds(normalize(def, 0));
	assert.deepStrictEqual(kinds({ type: 'accounts' }), ['account']);
	assert.deepStrictEqual(kinds({ type: 'paths', paths: ['/data'] }), ['path']);
	assert.deepStrictEqual(kinds({ type: 'command', command: 'du -sb /x' }), ['custom']);
	// dropping the mount layer stops the target claiming mount rows, so the ones
	// its last scan left behind are no longer served as current
	assert.deepStrictEqual(kinds({ type: 'containers' }), ['container', 'mount']);
	assert.deepStrictEqual(kinds({ type: 'containers', layers: ['writable'] }), ['container']);
});
