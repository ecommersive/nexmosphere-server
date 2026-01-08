let ws = null;
const logContainer = document.getElementById('logContainer');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const commandInput = document.getElementById('commandInput');

function getTimestamp() {
	return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function addLog(message, type = 'info') {
	const entry = document.createElement('div');
	entry.className = `log-entry ${type}`;
	entry.innerHTML = `<span class="timestamp">[${getTimestamp()}]</span>${message}`;
	logContainer.appendChild(entry);
	logContainer.scrollTop = logContainer.scrollHeight;
}

function clearLog() {
	logContainer.innerHTML = '';
	addLog('Log cleared', 'info');
}

function updateStatus(connected) {
	if (connected) {
		statusIndicator.classList.add('connected');
		statusText.textContent = 'Connected';
		connectBtn.style.display = 'none';
		disconnectBtn.style.display = 'inline-block';
	} else {
		statusIndicator.classList.remove('connected');
		statusText.textContent = 'Disconnected';
		connectBtn.style.display = 'inline-block';
		disconnectBtn.style.display = 'none';
	}
}

function connect() {
	const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	const wsUrl = `${protocol}//${window.location.host}`;
	
	addLog(`Connecting to ${wsUrl}...`, 'info');
	
	try {
		ws = new WebSocket(wsUrl);
		
		ws.onopen = () => {
			addLog('WebSocket connected successfully!', 'info');
			updateStatus(true);
		};
		
		ws.onmessage = (event) => {
			addLog(`RECEIVED: ${event.data}`, 'received');
		};
		
		ws.onerror = (error) => {
			addLog(`WebSocket error: ${error.message || 'Unknown error'}`, 'error');
		};
		
		ws.onclose = (event) => {
			addLog(`WebSocket closed (code: ${event.code}, reason: ${event.reason || 'none'})`, 'info');
			updateStatus(false);
			ws = null;
		};
	} catch (error) {
		addLog(`Failed to connect: ${error.message}`, 'error');
	}
}

function disconnect() {
	if (ws) {
		ws.close();
		addLog('Disconnecting...', 'info');
	}
}

async function sendCommand() {
	const command = commandInput.value.trim();
	if (!command) {
		addLog('Please enter a command', 'error');
		return;
	}
	
	addLog(`SENDING: ${command}`, 'sent');
	
	try {
		const response = await fetch('/send-command', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ command })
		});
		
		const data = await response.json();
		
		if (response.ok) {
			addLog(`Command queued successfully: ${data.command}`, 'info');
		} else {
			addLog(`Error: ${data.error}`, 'error');
		}
		
		commandInput.value = '';
		fetchQueueStatus();
	} catch (error) {
		addLog(`Failed to send command: ${error.message}`, 'error');
	}
}

async function fetchQueueStatus() {
	try {
		const response = await fetch('/queue-status');
		const data = await response.json();
		
		document.getElementById('queueLength').textContent = data.queueLength;
		document.getElementById('isProcessing').textContent = data.isProcessing ? 'Yes' : 'No';
		document.getElementById('rateLimit').textContent = `${data.rateLimitMs}ms`;
	} catch (error) {
		console.error('Failed to fetch queue status:', error);
	}
}

// Allow Enter key to send command
commandInput.addEventListener('keypress', (e) => {
	if (e.key === 'Enter') {
		sendCommand();
	}
});

// Fetch queue status periodically
setInterval(fetchQueueStatus, 1000);

// Initial status fetch
fetchQueueStatus();

// Auto-connect on page load
addLog('Nexmosphere WebSocket Test Client loaded', 'info');
addLog('Click "Connect" to establish WebSocket connection', 'info');
