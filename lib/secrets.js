const { scryptSync, randomBytes, timingSafeEqual } = require('crypto');

// Web login password, stored as an scrypt hash ("scrypt$<salt-hex>$<hash-hex>").
// SSH auth to the GPU servers uses keys / ssh-agent now (see lib/collector.js),
// so there is no SSH password to encrypt at rest anymore.

function hashWebPassword(password){
	const salt = randomBytes(16);
	const hash = scryptSync(password, salt, 32);
	return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyWebPassword(password, stored){
	if(typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
	const [, saltHex, hashHex] = stored.split('$');
	const expected = Buffer.from(hashHex, 'hex');
	const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
	return timingSafeEqual(actual, expected);
}

module.exports = { hashWebPassword, verifyWebPassword };
