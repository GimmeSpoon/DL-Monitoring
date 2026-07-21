// Event log: everything notable goes to the console AND the events table.
function createEvents({ db, log }){
	function logEvent(type, server, message){
		log(`(${type}) ${server ? `[${server}] ` : ''}${message}`);
		try{
			db.insertEvent(Math.floor(Date.now() / 1000), type, server, message);
		}
		catch(err){
			console.error('failed to persist event:', err);
		}
	}
	return { logEvent };
}

module.exports = { createEvents };
