const session = require('express-session');
const { verifyWebPassword } = require('./secrets');

// paths reachable without a login (the login page and what it needs)
const PUBLIC_PATHS = new Set(['/login.html', '/index.css', '/common.js', '/favicon.ico']);

function createAuth({ appConfig, onEvent }){

	const sessionMiddleware = session({
		secret: appConfig.sessionSecret,
		resave: false,
		saveUninitialized: false,
		cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
	});

	// everything except PUBLIC_PATHS requires a session:
	// API calls get a 401 (common.js redirects), pages get a 302
	function gate(req, res, next){
		// vendored libraries (jQuery, Chart.js) must load on the login page too,
		// before any session exists — they hold no data, so serve them ungated
		if(req.session.authed || PUBLIC_PATHS.has(req.path) || req.path.startsWith('/vendor/')){
			return next();
		}
		if(req.path.startsWith('/api/') || req.path === '/monitor'){
			return res.status(401).json({ error: 'unauthorized' });
		}
		return res.redirect('/login.html');
	}

	function login(req, res){
		const password = req.body && req.body.password;
		if(typeof password === 'string' && verifyWebPassword(password, appConfig.webPasswordHash)){
			req.session.authed = true;
			onEvent('login_ok', null, `login from ${req.ip}`);
			return res.status(204).end();
		}
		onEvent('login_fail', null, `failed login from ${req.ip}`);
		setTimeout(()=>res.status(401).json({ error: 'bad password' }), 500);
	}

	function logout(req, res){
		req.session.destroy(()=>res.status(204).end());
	}

	return { sessionMiddleware, gate, login, logout };
}

module.exports = { createAuth };
