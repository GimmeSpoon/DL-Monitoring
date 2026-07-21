// usage: npm run set-web-password -- <password>
const { saveAppConfig } = require('../lib/config');
const { hashWebPassword } = require('../lib/secrets');

const password = process.argv[2];
if(!password){
	console.error('Usage: npm run set-web-password -- <password>');
	process.exit(1);
}
saveAppConfig({ webPasswordHash: hashWebPassword(password) });
console.log('web password set.');
