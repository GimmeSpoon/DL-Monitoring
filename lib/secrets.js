const { readFileSync, writeFileSync } = require('fs');
const { scryptSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } = require('crypto');
const { config } = require('./config');

const algorithm = 'aes-192-cbc';

// ---- SSH password (encrypted at rest with the master key) ----
// v2 format: "v2$<salt-hex>$<iv-hex>$<ciphertext-hex>" (random salt + IV per save)

function savePassword(password, master){
	const salt = randomBytes(16);
	const iv = randomBytes(16);
	const key = scryptSync(master, salt, 24);
	const cipher = createCipheriv(algorithm, key, iv);
	const encrypted = cipher.update(password, 'utf8', 'hex') + cipher.final('hex');
	writeFileSync(config.passwdPath, `v2$${salt.toString('hex')}$${iv.toString('hex')}$${encrypted}`);
	console.log('password saved.');
	return password;
}

function loadPassword(master){
	const raw = readFileSync(config.passwdPath, 'utf-8').trim();
	if(!raw.startsWith('v2$')){
		throw Error(`${config.passwdPath} is in the old (broken) v1 format. Run once with both arguments to re-save it: npm start -- <MASTER_KEY> <SSH_PASSWORD>`);
	}
	const [, saltHex, ivHex, encrypted] = raw.split('$');
	const key = scryptSync(master, Buffer.from(saltHex, 'hex'), 24);
	const decipher = createDecipheriv(algorithm, key, Buffer.from(ivHex, 'hex'));
	return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8');
}

// ---- Web login password (stored as scrypt hash, never recoverable) ----
// hash format: "scrypt$<salt-hex>$<hash-hex>"

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

module.exports = { savePassword, loadPassword, hashWebPassword, verifyWebPassword };
