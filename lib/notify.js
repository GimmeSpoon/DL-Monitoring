// Outbound notification channels. One job: turn an alarm object into an HTTP
// POST at some third-party service. Nothing here knows *why* an alarm fired.
//
// Deliberately dependency-free (node http/https, not fetch) — the project still
// supports Node 14 via the better-sqlite3 fallback, where global fetch doesn't
// exist. A webhook POST is a dozen lines; a dependency for it isn't worth it.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const SEVERITIES = ['info', 'warning', 'critical'];

// Slack attachment colours, matched to the dashboard's own severity ramp so a
// message and the UI agree at a glance.
const COLOR = { info: '#22d3ee', warning: '#d6b02f', critical: '#f0533f', resolved: '#3fb950' };
const EMOJI = { info: ':information_source:', warning: ':warning:', critical: ':rotating_light:', resolved: ':white_check_mark:' };

function severityRank(s){
	const i = SEVERITIES.indexOf(String(s || 'info').toLowerCase());
	return i < 0 ? 0 : i;
}

// A channel may carry its webhook URL directly or name an env var holding it,
// so a deployment can keep the secret out of the config file entirely.
function channelUrl(ch){
	if(ch.urlEnv) return process.env[ch.urlEnv] || null;
	return ch.url || null;
}

// POST a JSON body. Resolves with {status, body} for any HTTP response — the
// caller decides what a 4xx means; rejects only on transport failure/timeout.
function postJson(url, payload, { headers, timeoutMs } = {}){
	return new Promise((resolve, reject)=>{
		let u;
		try{ u = new URL(url); }
		catch(e){ return reject(new Error(`bad webhook url: ${e.message}`)); }
		const lib = u.protocol === 'http:' ? http : https;
		const data = Buffer.from(JSON.stringify(payload), 'utf-8');
		const req = lib.request({
			protocol: u.protocol,
			hostname: u.hostname,
			port: u.port || undefined,
			path: u.pathname + u.search,
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...(headers || {}) },
		}, (res)=>{
			let body = '';
			res.setEncoding('utf-8');
			res.on('data', (c)=>{ if(body.length < 2000) body += c; });
			res.on('end', ()=>resolve({ status: res.statusCode, body: body.trim() }));
		});
		req.setTimeout(timeoutMs || 10000, ()=>req.destroy(new Error('webhook timed out')));
		req.on('error', reject);
		req.end(data);
	});
}

// Human one-liner used as the message title and the Slack notification text.
function titleOf(alarm){
	const where = [alarm.server, alarm.subject].filter(Boolean).join(' ');
	const state = alarm.state === 'resolved' ? 'RESOLVED' : String(alarm.severity || 'info').toUpperCase();
	return `[${state}] ${alarm.rule}${where ? ` — ${where}` : ''}`;
}

// Slack incoming-webhook payload. `text` is what a notification preview and a
// mobile push show, so the whole point of the message goes there; the coloured
// attachment carries the detail fields. Attachments (not blocks) on purpose:
// they are the only Slack surface with a left colour bar, which is what makes
// a critical alarm findable while scrolling a busy channel.
function slackPayload(alarm, ch){
	const color = alarm.state === 'resolved' ? COLOR.resolved : (COLOR[alarm.severity] || COLOR.info);
	const emoji = alarm.state === 'resolved' ? EMOJI.resolved : (EMOJI[alarm.severity] || EMOJI.info);
	const fields = [];
	if(alarm.server) fields.push({ title: 'Server', value: alarm.server, short: true });
	if(alarm.subject) fields.push({ title: 'Where', value: alarm.subject, short: true });
	if(alarm.valueText) fields.push({ title: 'Value', value: alarm.valueText, short: true });
	if(alarm.forText) fields.push({ title: alarm.state === 'resolved' ? 'Lasted' : 'For', value: alarm.forText, short: true });

	const payload = {
		text: `${emoji} ${titleOf(alarm)}`,
		attachments: [{
			color,
			fallback: `${titleOf(alarm)}: ${alarm.message}`,
			title: alarm.rule,
			text: alarm.message,
			fields,
			footer: alarm.origin || 'Server Monitor',
			ts: alarm.ts,
			mrkdwn_in: ['text', 'fields'],
		}],
	};
	// Optional overrides; a modern Slack app ignores channel/username/icon unless
	// the webhook was created with them allowed, so they are only sent when set.
	if(ch.channel) payload.channel = ch.channel;
	if(ch.username) payload.username = ch.username;
	if(ch.iconEmoji) payload.icon_emoji = ch.iconEmoji;
	return payload;
}

// Generic webhook: the alarm itself, so a receiving service can route on the
// raw fields instead of parsing prose.
function webhookPayload(alarm){
	return { ...alarm, title: titleOf(alarm) };
}

const BUILDERS = { slack: slackPayload, webhook: webhookPayload, discord: discordPayload };

// Discord accepts a Slack-shaped body at /slack, but its native form is one
// embed — cheap to support and it keeps the colour bar.
function discordPayload(alarm){
	const color = alarm.state === 'resolved' ? COLOR.resolved : (COLOR[alarm.severity] || COLOR.info);
	return {
		content: titleOf(alarm),
		embeds: [{ title: alarm.rule, description: alarm.message, color: parseInt(color.slice(1), 16) }],
	};
}

// Deliver one alarm to one channel. `minSeverity` lets a noisy channel take
// everything while a paging channel takes only criticals; a resolve notice is
// always allowed through if its firing counterpart was (same severity).
async function deliver(ch, alarm){
	if(ch.enabled === false) return { sent: false, reason: 'channel disabled' };
	if(severityRank(alarm.severity) < severityRank(ch.minSeverity)) return { sent: false, reason: 'below channel minSeverity' };
	const url = channelUrl(ch);
	if(!url) return { sent: false, reason: ch.urlEnv ? `env ${ch.urlEnv} is not set` : 'no url configured' };
	const build = BUILDERS[ch.type] || BUILDERS.webhook;
	const res = await postJson(url, build(alarm, ch), { headers: ch.headers, timeoutMs: ch.timeoutMs });
	if(res.status < 200 || res.status >= 300){
		throw new Error(`HTTP ${res.status}${res.body ? `: ${res.body.slice(0, 120)}` : ''}`);
	}
	return { sent: true, status: res.status };
}

// what the UI may see: never the webhook URL (it is a bearer secret)
function redactChannel(name, ch){
	const url = channelUrl(ch);
	return {
		name,
		type: ch.type || 'webhook',
		enabled: ch.enabled !== false,
		minSeverity: ch.minSeverity || 'info',
		target: ch.channel || null,
		configured: !!url,
		source: ch.urlEnv ? `env ${ch.urlEnv}` : (ch.url ? 'alarms.json' : 'unset'),
	};
}

module.exports = { deliver, postJson, slackPayload, webhookPayload, titleOf, severityRank, redactChannel, channelUrl, SEVERITIES };
