// Shared across every page: inline SVG icons (self-contained, no icon CDN),
// theme handling, nav, and the "session expired -> login" redirect.

window.ICONS = {
	signal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3l2 6 4-14 2 8h2l2 4h3"/></svg>',
	sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
	moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
	user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
	fan: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12C10.8 7.5 12.2 3.2 15.4 3 15.9 6.2 14.3 9.6 12 12Z"/><path d="M12 12C16.5 10.8 20.8 12.2 21 15.4 17.8 15.9 14.4 14.3 12 12Z"/><path d="M12 12C13.2 16.5 11.8 20.8 8.6 21 8.1 17.8 9.7 14.4 12 12Z"/><path d="M12 12C7.5 13.2 3.2 11.8 3 8.6 6.2 8.1 9.6 9.7 12 12Z"/><circle cx="12" cy="12" r="2.3" fill="var(--raised)"/><circle cx="12" cy="12" r="1.15"/></svg>',
	refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
	box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v8l-9 5-9-5V8l9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
	folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};

function applyTheme(theme){
	localStorage.setItem('color-theme', theme);
	document.documentElement.setAttribute('color-theme', theme);
	const btn = document.getElementById('skin');
	if(btn) btn.innerHTML = theme === 'dark' ? window.ICONS.moon : window.ICONS.sun;
	if(window.jQuery) $(document).trigger('themechange', theme);
}

// apply before first paint (script is in <head>); dark is the default
applyTheme(localStorage.getItem('color-theme') || 'dark');

$(function(){
	// #skin isn't in the DOM when the head-run applyTheme fires, so its icon
	// goes unpainted on first load; paint it now that the button exists.
	$('#skin').html(document.documentElement.getAttribute('color-theme') === 'dark' ? window.ICONS.moon : window.ICONS.sun);
	$('#skin').on('click', ()=>{
		applyTheme(document.documentElement.getAttribute('color-theme') === 'dark' ? 'light' : 'dark');
	});

	const here = window.location.pathname;
	const link = (href, label)=>`<a href="${href}" class="${here === href ? 'active' : ''}">${label}</a>`;
	$('#nav').html(link('/', 'Dashboard') + link('/storage.html', 'Storage') + link('/services.html', 'Services') + link('/alarms.html', 'Alarms') + link('/history.html', 'History') + link('/logs.html', 'Logs'));

	$('#logout').on('click', (evnt)=>{
		evnt.preventDefault();
		$.post('/api/logout').always(()=>{ window.location.href = '/login.html'; });
	});
});

// session expired -> back to login
$(document).ajaxError((evnt, xhr)=>{
	if(xhr.status === 401 && !window.location.pathname.endsWith('/login.html')){
		window.location.href = '/login.html';
	}
});

// fill a <select> with known servers (live + historical)
window.populateServers = function($sel, done){
	$.getJSON('/api/servers').done((data)=>{
		$sel.html(data.servers.map((s)=>
			`<option value="${s.name}">${s.name}${s.online ? '' : ' (offline)'}</option>`).join(''));
		if(done) done(data.servers);
	});
};
