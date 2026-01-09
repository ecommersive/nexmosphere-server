const express = require('express');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const sound = require("sound-play");
const path = require("path");
const mistpath = path.join(__dirname, 'sounds', "mist.wav");
const maskpath = path.join(__dirname, 'sounds', "mask.wav");
// Define CORS options
const corsOptions = {
	origin: 'http://localhost:3001', // Replace with your frontend URL
	methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', // Allowed methods
	credentials: true, // Allow cookies and authorization headers
	optionsSuccessStatus: 204, // For legacy browser support
};

const app = express();
app.use(cors(corsOptions));
app.use(express.json());

let port;

// Get COM port from command line argument (e.g., "bun index.js 4" for COM4)
const comPortArg = process.argv[2];

// Function to get or auto-detect the serial port
async function getSerialPort() {
	const ports = await SerialPort.list();

	if (ports.length === 0) {
		console.error('No serial ports found.');
		process.exit(1);
	}

	let selectedPort;

	if (comPortArg) {
		// User specified a COM port number
		const targetPath = process.platform === 'win32' 
			? `COM${comPortArg}` 
			: `/dev/ttyUSB${comPortArg}`; // Linux/Mac fallback
		
		const found = ports.find(p => p.path === targetPath || p.path.endsWith(comPortArg));
		
		if (found) {
			selectedPort = found.path;
		} else {
			console.error(`Port ${targetPath} not found. Available ports:`);
			ports.forEach(p => console.log(`  - ${p.path} (${p.friendlyName || p.manufacturer || 'Unknown'})`));
			process.exit(1);
		}
	} else {
		// Auto-detect: use first available port
		selectedPort = ports[0].path;
		console.log('No port specified, auto-detecting...');
	}

	console.log(`Using port: ${selectedPort}`);

	return new SerialPort({
		path: selectedPort,
		baudRate: 115200
	});
}

(async () => {
	port = await getSerialPort();
	const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

	// Rate-limited command queue (1 command per 300ms)
	const RATE_LIMIT_MS = 300;
	const commandQueue = [];
	let isProcessingQueue = false;
	let lastCommandTime = 0;

	// Store all connected WebSocket clients
	const connectedClients = new Set();

	// Log port events for debugging
	port.on('open', () => {
		console.log('[PORT] Serial port opened successfully');
		console.log(`[PORT] Settings: ${port.baudRate} baud, ${port.dataBits} data bits, ${port.stopBits} stop bits, parity: ${port.parity}`);
	});

	port.on('error', (err) => {
		console.error(`[PORT-ERROR] Serial port error: ${err.message}`);
	});

	port.on('close', () => {
		console.log('[PORT] Serial port closed');
	});

	// Listen for data from serial port at the top level
	parser.on('data', (data) => {
		console.log(`[SERIAL-IN] Data received from serial port: "${data}"`);
		
		// Broadcast to all connected WebSocket clients
		connectedClients.forEach((client) => {
			if (client.readyState === 1) { // 1 = OPEN
				console.log(`[WEBSOCKET-BROADCAST] Sending to client: "${data}"`);
				client.send(data);
			}
		});
	});

	parser.on('error', (err) => {
		console.error(`[PARSER-ERROR] Parser error: ${err.message}`);
	});

	function processQueue() {
		if (isProcessingQueue || commandQueue.length === 0) return;
		isProcessingQueue = true;

		const now = Date.now();
		const timeSinceLastCommand = now - lastCommandTime;
		const delay = Math.max(0, RATE_LIMIT_MS - timeSinceLastCommand);

		setTimeout(() => {
			const { command, resolve, reject } = commandQueue.shift();
			lastCommandTime = Date.now();

			port.write(command, (err) => {
				if (err) {
					console.error(`[ERROR] Failed to send command: "${command.trim()}" | Error: ${err.message}`);
					reject('Error sending command: ' + err.message);
				} else {
					console.log(`[SENT] Command sent to serial port: "${command.trim()}"`);
					resolve({ success: true, command: command.trim() });
				}
				isProcessingQueue = false;
				processQueue(); // Process next command in queue
			});
		}, delay);
	}

	function queueCommand(command) {
		return new Promise((resolve, reject) => {
			commandQueue.push({ command, resolve, reject });
			console.log(`[QUEUE] Command queued: "${command.trim()}" | Queue length: ${commandQueue.length}`);
			processQueue();
		});
	}

	async function sendCommand(command) {
		return new Promise((resolve, reject) => {
			// Send the command to the serial port
			port.write(command, (err) => {
				if (err) {
					console.error(`[ERROR] Failed to send command: "${command.trim()}" | Error: ${err.message}`);
					return reject('Error sending command: ' + err.message);
				}
				console.log(`[SENT] Command sent: "${command.trim()}"`);
			});

			// Listen for data from the serial port
			const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
			parser.once('data', (response) => {
				console.log(`[RESPONSE] Response received: "${response}"`);
				resolve(response);
			});
		});
	}

	// Example of a function to send the status request command
	async function checkRFIDStatus(xTalkChannel = '008') {
		const command = `X${xTalkChannel}B[]\r\n`; // Replace 001 with the desired channel number
		try {
			const response = await sendCommand(command);
			return response;
		} catch (error) {
			console.error('Error checking RFID status:', error);
			return null;
		}
	}


	// Serve Nexmosphere WebSocket test client
	app.use('/nextest', express.static(path.join(__dirname, 'nextest')));

	app.get('/playmist', async (req, res) => {
		await sound.play(mistpath);
		res.send('played mist');
	});

	app.get('/playmask', async (req, res) => {
		await sound.play(maskpath);
		res.send('played mask');
	});

	// POST endpoint to send commands to the device (rate-limited)
	app.post('/send-command', async (req, res) => {
		const { command } = req.body;
		if (!command) {
			console.warn('[WARN] POST /send-command received without command parameter');
			return res.status(400).json({ error: 'Command is required' });
		}
		try {
			console.log(`[INCOMING] POST /send-command received: "${command}"`);
			// Ensure command ends with \r\n for Nexmosphere protocol
			const formattedCommand = command.endsWith('\r\n') ? command : command + '\r\n';
			const result = await queueCommand(formattedCommand);
			console.log(`[SUCCESS] Command processed: "${command}"`);
			res.json(result);
		} catch (error) {
			console.error(`[ERROR] POST /send-command failed: "${command}" | Error: ${error.toString()}`);
			res.status(500).json({ error: error.toString() });
		}
	});

	// GET endpoint to check queue status
	app.get('/queue-status', (req, res) => {
		res.json({
			queueLength: commandQueue.length,
			isProcessing: isProcessingQueue,
			rateLimitMs: RATE_LIMIT_MS
		});
	});

	app.get('/check-rfid-status', async (req, res) => {
		function getStickers(string) {
			if (!string || !string.includes('[')) return []
			string = string.split('[')[1]
			string = string.split(']')[0]
			console.log('string', string)
			return string.split(' ')
				.filter(x => x)
				.map(x => x.replace('d', ''))
				.filter(x => x !== '000')
				.map(x => x == '001' ? 'mist' : 'mask')

		}
		const { channel } = req.query; // Optional channel query param
		const xTalkChannel = channel || '008'; // Default to channel 001 if not provided
		const status = await checkRFIDStatus(xTalkChannel);
		if (status) {

			res.send(getStickers(status));
		} else {
			res.status(500).send('Failed to check RFID status');
		}
	});

	const server = app.listen(3001, () => {
		console.log('Server running on port 3001');
	});

	const wss = new WebSocketServer({ server });
	wss.on('connection', (ws) => {
		console.log('[WEBSOCKET] Client connected via WebSocket');
		connectedClients.add(ws);

		ws.on('message', (message) => {
			console.log(`[WEBSOCKET-MESSAGE] Message received from client: "${message}"`);
		});

		ws.on('close', () => {
			console.log('[WEBSOCKET] Client disconnected');
			connectedClients.delete(ws);
		});

		ws.on('error', (error) => {
			console.error(`[WEBSOCKET-ERROR] WebSocket error: ${error.message}`);
			connectedClients.delete(ws);
		});
	});

	// Serve the HTML file
	app.use(express.static(path.join(__dirname, 'public')));
})();

// set interval for 10 seconds and log out hello world
// set interval to 15 mins 


