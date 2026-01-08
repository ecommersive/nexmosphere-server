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
	origin: 'http://localhost:3000', // Replace with your frontend URL
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
					reject('Error sending command: ' + err.message);
				} else {
					console.log('Command sent (rate-limited):', command.trim());
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
			console.log(`Command queued. Queue length: ${commandQueue.length}`);
			processQueue();
		});
	}

	async function sendCommand(command) {
		return new Promise((resolve, reject) => {
			// Send the command to the serial port
			port.write(command, (err) => {
				if (err) {
					return reject('Error sending command: ' + err.message);
				}
				console.log('Command sent:', command);
			});

			// Listen for data from the serial port
			const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
			parser.once('data', (response) => {
				console.log('Response received:', response);
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

	// Serve static files from the 'dist' directory
	app.use(express.static(path.join(__dirname, 'dist')));

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
			return res.status(400).json({ error: 'Command is required' });
		}
		try {
			// Ensure command ends with \r\n for Nexmosphere protocol
			const formattedCommand = command.endsWith('\r\n') ? command : command + '\r\n';
			const result = await queueCommand(formattedCommand);
			res.json(result);
		} catch (error) {
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
		console.log('Client connected via WebSocket');
		parser.on('data', (data) => {
			console.log('Data received: ', data);
			ws.send(data);
		});

		ws.on('close', () => {
			console.log('Client disconnected');
		});
	});
	app.get('*', (req, res) => {
		res.sendFile(path.join(__dirname, 'dist', 'index.html'));
	});
	// Serve the HTML file
	app.use(express.static(path.join(__dirname, 'public')));
})();

// set interval for 10 seconds and log out hello world
// set interval to 15 mins 


