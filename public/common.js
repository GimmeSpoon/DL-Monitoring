// Shared by every page: theme handling (was duplicated in v1), top nav
// injection, and the global "session expired -> login page" redirect.

function applyTheme(theme){
	localStorage.setItem('color-theme', theme);
	document.documentElement.setAttribute('color-theme', theme);
	$(document).trigger('themechange', theme);
}

// apply immediately (script is loaded in <head>) to avoid a flash of wrong theme
applyTheme(localStorage.getItem('color-theme')
	|| (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

$(function(){
	$('#skin').prop('checked', localStorage.getItem('color-theme') === 'dark');
	$('#skin').on('change', (evnt)=>{
		applyTheme(evnt.target.checked ? 'dark' : 'light');
	});

	const here = window.location.pathname;
	const link = (href, label)=>`<a href="${href}" class="${here === href ? 'active' : ''}">${label}</a>`;
	$('#nav').html(
		link('/', 'DASHBOARD') +
		link('/history.html', 'HISTORY') +
		link('/logs.html', 'LOGS') +
		`<a href="#" id="logout">LOGOUT</a>`
	);
	$('#logout').on('click', (evnt)=>{
		evnt.preventDefault();
		$.post('/api/logout').always(()=>{ window.location.href = '/login.html'; });
	});
});

// fill a <select> with the known servers (live + historical)
function populateServers($sel, done){
	$.getJSON('/api/servers').done((data)=>{
		$sel.html(data.servers.map((s)=>
			`<option value="${s.name}">${s.name}${s.online ? '' : ' (offline)'}</option>`).join(''));
		if(done) done(data.servers);
	});
}

// any API call answered with 401 -> back to the login page
$(document).ajaxError((evnt, xhr)=>{
	if(xhr.status === 401 && !window.location.pathname.endsWith('/login.html')){
		window.location.href = '/login.html';
	}
});
